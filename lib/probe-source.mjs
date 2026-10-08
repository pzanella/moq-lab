// Probes a remote source (stream.sh --source: an http(s) MP4, HLS, or DASH URL)
// and picks which of its streams run-stream.sh publishes. Prints one line for
// the shell to `read`:
//
//   <video index> <video codec> <audio index> <audio codec> <format> <duration|live>
//
// HLS and DASH can carry a whole ladder, which ffprobe reports as one program
// per variant (HLS) or as a flat list of representations (DASH). We want one
// video and one audio: the highest-resolution video, with an audio track from
// the same variant, so ffmpeg only downloads that one variant. When variants tie
// on resolution, the one with AAC audio wins -- it can be copied as-is instead
// of re-encoded (Apple's examples ship AC-3 variants alongside AAC ones).
//
// Usage: node probe-source.mjs <url>   (exits 1, with a reason on stderr, on failure)
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Network protocols only: a playlist must not be able to point ffmpeg at a local
// file (file://) or anything else. crypto is for AES-128 encrypted HLS segments.
// Keep in sync with SOURCE_OPTS in run-stream.sh.
const PROTOCOL_WHITELIST = "http,https,tcp,tls,crypto";
const PROBE_TIMEOUT_MS = 60_000;

const area = (s) => (s.width ?? 0) * (s.height ?? 0);

// The best video in `streams`, paired with its best audio (AAC first, else the first one).
function pickPair(streams) {
    const video = streams.filter((s) => s.codec_type === "video").sort((a, b) => area(b) - area(a))[0];
    const audios = streams.filter((s) => s.codec_type === "audio");
    const audio = audios.find((s) => s.codec_name === "aac") ?? audios[0];
    return video && audio ? { video, audio } : null;
}

function pickStreams({ programs = [], streams = [] }) {
    const groups = programs.length > 0 ? programs.map((p) => p.streams ?? []) : [streams];
    const score = ({ video, audio }) => area(video) * 2 + (audio.codec_name === "aac" ? 1 : 0);
    return groups
        .map(pickPair)
        .filter(Boolean)
        .sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function main(url) {
    if (!/^https?:\/\/\S+$/.test(url ?? "")) {
        throw new Error(`not an http(s) URL: ${url}`);
    }

    let stdout;
    try {
        ({ stdout } = await promisify(execFile)("ffprobe", [
            "-v", "error",
            "-protocol_whitelist", PROTOCOL_WHITELIST,
            "-show_programs", "-show_streams", "-show_format",
            "-of", "json",
            url,
        ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }));
    } catch (err) {
        const reason = err.killed ? `no answer within ${PROBE_TIMEOUT_MS / 1000}s` : (err.stderr?.trim() || err.message);
        throw new Error(`cannot read the source: ${reason}`);
    }

    const probe = JSON.parse(stdout);
    const pair = pickStreams(probe);
    if (!pair) {
        throw new Error(`${url} has no variant with both a video and an audio track`);
    }

    const duration = Number(probe.format?.duration);
    console.log([
        pair.video.index, pair.video.codec_name,
        pair.audio.index, pair.audio.codec_name,
        probe.format?.format_name ?? "unknown",
        Number.isFinite(duration) && duration > 0 ? duration.toFixed(1) : "live",
    ].join(" "));
}

main(process.argv[2]).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
});
