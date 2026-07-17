// Minimal `--key value` argv parser shared by the host-side SGAI scripts.
// Not used for the ssai/csai proxies, which take positional args instead
// (they're piped inside an ffmpeg | proxy | moq shell pipeline, not run
// standalone with named flags).
export function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]?.replace(/^--/, "");
        if (!key) continue;
        args[key] = argv[i + 1];
    }
    return args;
}
