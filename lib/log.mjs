// Shared stderr logger: every proxy/publisher script in this sandbox tags its
// output with a bracketed prefix and an ISO timestamp, so logs from parallel
// processes (ffmpeg | proxy | moq, or a host-side script) stay attributable.
export function createLogger(prefix) {
    return (msg) => {
        process.stderr.write(`[${prefix}] ${new Date().toISOString()} ${msg}\n`);
    };
}
