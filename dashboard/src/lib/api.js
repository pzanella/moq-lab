// Talks to dashboard/server/server.mjs, the container-side half of the dashboard.

export async function fetchConfig() {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`/api/config: HTTP ${res.status}`);
    return res.json();
}

// The relay is published on the same host the dashboard was opened from.
// http:// (not https://) is deliberate: @moq/net then fetches the relay's
// self-signed certificate fingerprint from /certificate.sha256 and pins it for
// the WebTransport session, so there's no browser certificate warning to click through.
export function relayUrlFor(config) {
    const url = new URL(`http://${window.location.hostname}:${config.relayPort}/`);
    if (config.jwt) url.searchParams.set("jwt", config.jwt);
    return url.toString();
}

// The ingest clock is the container's, the arrival clock is this browser's. On
// macOS those are different machines (the podman VM and the host) and can drift
// apart, so estimate the offset NTP-style and keep the sample with the smallest
// round trip, whose midpoint guess is the tightest.
export async function measureClockOffset(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
        const t0 = Date.now();
        const res = await fetch("/api/time", { cache: "no-store" });
        const { now } = await res.json();
        const t1 = Date.now();
        const rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt, offset: now - (t0 + t1) / 2 };
    }
    return best;
}

export function subscribeEvents({ onLog, onIngest, onStatus }) {
    const source = new EventSource("/api/events");
    source.addEventListener("open", () => onStatus(true));
    source.addEventListener("error", () => onStatus(false));
    source.addEventListener("log", (e) => onLog(JSON.parse(e.data)));
    source.addEventListener("ingest", (e) => onIngest(JSON.parse(e.data)));
    return () => source.close();
}
