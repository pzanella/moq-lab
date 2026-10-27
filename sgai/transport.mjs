// Shared MoQ relay connection helper for the host-side SGAI scripts.
//
// These scripts run in plain Node (not the browser), so a few things the
// player's client code gets for free are missing:
//   1. No native WebTransport — @moq/net falls back to its WebSocket
//      transport (@moq/qmux) automatically, but that requires a global
//      `WebSocket` constructor, which Node only ships (stable) from v22.
//      This project's engine floor is Node >=20 (see package.json), so we
//      polyfill from `ws`.
//   2. The sandbox relay (run-stream.sh) generates a
//      self-signed TLS certificate. Browsers get a one-time "accept the
//      warning" step; Node's TLS stack has no equivalent, so the polyfilled
//      WebSocket must be told not to reject it.
//   3. @moq/net and @moq/qmux call `Promise.withResolvers()`, which V8
//      only shipped from Node 21.7/22 — also missing on Node 20.
import { WebSocket as NodeWebSocket } from "ws";

class InsecureWebSocket extends NodeWebSocket {
    constructor(address, protocols) {
        // Local sandbox only: run-stream.sh's relay always uses a self-signed cert.
        super(address, protocols, { rejectUnauthorized: false });
    }
}

if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = InsecureWebSocket;
}

if (typeof Promise.withResolvers !== "function") {
    Promise.withResolvers = function withResolvers() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}

const Moq = await import("@moq/net");

/**
 * Connects to a MoQ relay over WebSocket (WebTransport is unavailable in Node).
 * `publish` serves the broadcasts of an Origin.Producer you fill; `consume` is the
 * Origin.Producer that receives the relay's broadcasts. Both are optional.
 * @param {string} url - e.g. "https://localhost:4443"
 */
export async function connectRelay(url, { publish, consume } = {}) {
    return Moq.Connection.connect({ url: new URL(url), websocket: { enabled: true }, publish, consume });
}

// The conventional MSF catalog track name (rs/moq-msf's `Catalog::DEFAULT_NAME`;
// @moq/msf doesn't export the constant). No ".json" suffix -- that's hang's convention.
export const CATALOG_TRACK_NAME = "catalog";

// Subscribing to a broadcast before the relay has announced it gets the
// stream reset instead of queued -- wait for the ANNOUNCE first. Shared by
// every host-side script that consumes a broadcast it doesn't itself own.
// `origin` is the Origin.Producer passed to connectRelay() as `consume`.
// Resolves with the broadcast, or undefined once `signal` aborts or `timeoutMs` passes.
export async function waitForBroadcast(origin, name, { signal, timeoutMs } = {}) {
    const request = origin.request(Moq.Path.from(name), { announced: true });
    const active = await waitForActive(request, signal, timeoutMs);
    if (!active) request.close();
    return active;
}

// Like waitForBroadcast(), for a caller that only needs to know the broadcast is
// there: resolves true or false, and doesn't keep the request open.
export async function waitForAnnounced(origin, name, { signal, timeoutMs } = {}) {
    const request = origin.request(Moq.Path.from(name), { announced: true });
    try {
        return (await waitForActive(request, signal, timeoutMs)) !== undefined;
    } finally {
        request.close();
    }
}

// A plain timer, not AbortSignal.timeout() inside AbortSignal.any(): on Node 20 the
// combined signal can be garbage-collected before it fires, and the wait never ends.
async function waitForActive(request, signal, timeoutMs) {
    let timer;
    let onAbort;
    const stop = new Promise((resolve) => {
        if (timeoutMs !== undefined) timer = setTimeout(resolve, timeoutMs);
        onAbort = resolve;
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
    });
    let stopped = false;
    stop.then(() => {
        stopped = true;
    });
    try {
        for (;;) {
            const active = request.active.peek();
            if (active || stopped) return active;
            await Promise.race([request.active.changed(), stop]);
        }
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

export { Moq };
