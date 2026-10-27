// Ingest-side half of the dashboard's end-to-end latency readout (see README.md,
// "Dashboard"). The pass-through proxies sitting right before `moq import` call
// this with every video decode time they see.
//
// `moq import` doesn't keep the source's timestamps: it maps the first frame it
// gets to the moment it got it, and the catalog's `clock.wall` turns any
// timestamp into that wall-clock time. If the first frame passed late, every
// frame after it looks early by the same amount. This works out that amount
// (startLagMs), and the browser adds it back to the latency.
//
// Enabled only when run-stream.sh sets MOQ_LAB_INGEST_CLOCK (i.e. the
// dashboard is on); otherwise the returned function is a no-op.
import { renameSync, writeFileSync } from "node:fs";

const WRITE_INTERVAL_MS = 500;

export function createIngestClock(file = process.env.MOQ_LAB_INGEST_CLOCK) {
    if (!file) return () => {};
    let lastWrite = 0;
    let prevMediaSecs = null;
    let firstOffsetMs = null;
    let baselineMs = Infinity;

    return (mediaSecs) => {
        const wallMs = Date.now();
        const offsetMs = wallMs - mediaSecs * 1000;
        // A jump back is a restart (SSAI pass, PTS wrap): a new run, with its own start.
        if (prevMediaSecs !== null && mediaSecs < prevMediaSecs - 1) {
            firstOffsetMs = null;
            baselineMs = Infinity;
        }
        prevMediaSecs = mediaSecs;
        // The first frame of the run is the one `moq import` maps to "now".
        firstOffsetMs ??= offsetMs;

        // ffmpeg -re releases media at wall-clock pace from the start of the run, so
        // media time m is due at start + m. Frames can only pass here at or after
        // that: the muxer hands them over in interleave bursts (~0.5s of media at
        // once), and an encode or publish that can't keep up falls further behind.
        // The smallest wall - media offset since the run started is therefore the
        // source's own pace, and measuring against it -- rather than against when
        // each frame happened to pass -- keeps both of those in the latency figure.
        baselineMs = Math.min(baselineMs, offsetMs);

        if (wallMs - lastWrite < WRITE_INTERVAL_MS) return;
        lastWrite = wallMs;
        // Write-then-rename so the dashboard server never reads a half-written file.
        writeFileSync(`${file}.tmp`, JSON.stringify({ startLagMs: firstOffsetMs - baselineMs }));
        renameSync(`${file}.tmp`, file);
    };
}
