// Display formatting and health thresholds. Thresholds are tuned for what this
// sandbox should look like on a local or LAN link; anything amber or red here
// is worth a look in the logs.

export const DASH = "—";

export function fixed(value, digits = 0) {
    return value === null || value === undefined || Number.isNaN(value) ? DASH : value.toFixed(digits);
}

export function grade(value, warnAt, criticalAt) {
    if (value === null || value === undefined) return "idle";
    if (value >= criticalAt) return "critical";
    if (value >= warnAt) return "warning";
    return "good";
}

export const THRESHOLDS = {
    rtt: [50, 150], // ms
    loss: [1, 3], // %
    // Not VoIP's 30 ms: ffmpeg's muxer releases frames in ~0.5s interleave bursts
    // (see lib/ingest-clock.mjs), so a healthy local stream already sits near 50 ms.
    jitter: [100, 250], // ms
    latency: [1000, 3000], // ms
};

export function gradeFps(measured, nominal) {
    if (measured === null || measured === undefined || !nominal) return "idle";
    const ratio = measured / nominal;
    if (ratio >= 0.9) return "good";
    if (ratio >= 0.6) return "warning";
    return "critical";
}

export const STATUS_LABEL = {
    good: "Healthy",
    warning: "Warning",
    critical: "Critical",
    idle: "No data",
};

export function clockTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour12: false });
}

export function clockTimeMillis(ms) {
    const d = new Date(ms);
    return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function duration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export function mbps(bitsPerSecond) {
    return bitsPerSecond ? `${(bitsPerSecond / 1e6).toFixed(2)} Mbps` : DASH;
}
