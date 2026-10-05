// Ingest-side half of the dashboard's end-to-end latency readout (see README.md,
// "Dashboard"). The pass-through proxies sitting right before `moq import` call
// this with every video decode time they see. It works out the wall-clock
// instant each media time was due at the source, and the browser subtracts
// that from when the same media time arrives over MoQ.
//
// Enabled only when run-stream.sh sets MOQ_LAB_INGEST_CLOCK (i.e. the
// dashboard is on); otherwise the returned function is a no-op.
import { renameSync, writeFileSync } from "node:fs";

const WRITE_INTERVAL_MS = 500;

export function createIngestClock(file = process.env.MOQ_LAB_INGEST_CLOCK) {
    if (!file) return () => {};
    let lastWrite = 0;
    let prevMediaSecs = null;
    let baselineMs = Infinity;

    return (mediaSecs) => {
        const wallMs = Date.now();
        // A jump back is a restart (SSAI pass, PTS wrap): a new run, with its own start.
        if (prevMediaSecs !== null && mediaSecs < prevMediaSecs - 1) baselineMs = Infinity;
        prevMediaSecs = mediaSecs;

        // ffmpeg -re releases media at wall-clock pace from the start of the run, so
        // media time m is due at start + m. Frames can only pass here at or after
        // that: the muxer hands them over in interleave bursts (~0.5s of media at
        // once), and an encode or publish that can't keep up falls further behind.
        // The smallest wall - media offset since the run started is therefore the
        // source's own pace, and measuring against it -- rather than against when
        // each frame happened to pass -- keeps both of those in the latency figure.
        baselineMs = Math.min(baselineMs, wallMs - mediaSecs * 1000);

        if (wallMs - lastWrite < WRITE_INTERVAL_MS) return;
        lastWrite = wallMs;
        // Write-then-rename so the dashboard server never reads a half-written file.
        // wallMs here is when mediaSecs was due at the source, not when it passed.
        writeFileSync(`${file}.tmp`, JSON.stringify({ mediaSecs, wallMs: mediaSecs * 1000 + baselineMs }));
        renameSync(`${file}.tmp`, file);
    };
}
