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
 * @param {string} url - e.g. "https://localhost:4443"
 */
export async function connectRelay(url) {
    return Moq.Connection.connect(new URL(url), { websocket: { enabled: true } });
}

// The conventional MSF catalog track name (rs/moq-msf's `Catalog::DEFAULT_NAME`;
// @moq/msf doesn't export the constant). No ".json" suffix -- that's hang's convention.
export const CATALOG_TRACK_NAME = "catalog";

export { Moq };
