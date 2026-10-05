#!/usr/bin/env node
// SSAI impression tracker — transparent fMP4 pipeline proxy.
// Usage: ffmpeg ... | node impression-tracker.mjs <adBreakEvery> <adBreakLength> | moq import fmp4
//
// Reads raw fMP4 from stdin, passes every byte unchanged to stdout,
// and logs impression events when the stream PTS crosses ad quartile thresholds.
import { createLogger } from "../lib/log.mjs";
import { FMP4Inspector } from "../lib/fmp4.mjs";
import { createIngestClock } from "../lib/ingest-clock.mjs";

const log = createLogger("SSAI");

const AD_BREAK_EVERY = Number(process.argv[2] ?? 30);
if (process.argv[3] === undefined) {
    process.stderr.write("[SSAI] error: adBreakLength argument is required (read it from ffprobe in the caller)\n");
    process.exit(1);
}
const AD_BREAK_LENGTH = Number(process.argv[3]);
if (isNaN(AD_BREAK_LENGTH) || AD_BREAK_LENGTH <= 0) {
    process.stderr.write(`[SSAI] error: invalid adBreakLength: ${process.argv[3]}\n`);
    process.exit(1);
}
const CYCLE_SECS = AD_BREAK_EVERY + AD_BREAK_LENGTH;

const QUARTILES = [
    { event: "start", pct: 0 },
    { event: "first_quartile", pct: 0.25 },
    { event: "midpoint", pct: 0.5 },
    { event: "third_quartile", pct: 0.75 },
];

// Impression tracking — driven entirely by stream PTS, no timers.
const fired = new Set();
let lastPts = -1;
let ptsBase = 0;
let lastCycle = -1;

function onVideoTimestamp(pts) {
    // Detect a PTS reset when ffmpeg restarts for the next pass.
    if (lastPts >= 0 && pts < lastPts - CYCLE_SECS) {
        ptsBase += Math.ceil(lastPts / CYCLE_SECS) * CYCLE_SECS;
        log(`PTS reset — base now ${ptsBase.toFixed(3)}s`);
    }
    lastPts = pts;

    const streamSecs = pts + ptsBase;
    const cycleIndex = Math.floor(streamSecs / CYCLE_SECS);
    const cyclePos = streamSecs % CYCLE_SECS;

    // 'complete' fires here, on cycle advance, rather than as a quartile -- modulo
    // can never reach CYCLE_SECS itself. Log the nominal end time, not the actual one.
    if (lastCycle >= 0 && cycleIndex > lastCycle) {
        const key = `${lastCycle}:complete`;
        if (!fired.has(key)) {
            fired.add(key);
            const nominalEnd = (lastCycle + 1) * CYCLE_SECS;
            log(`break=${lastCycle} | ${"complete".padEnd(16)} | 100% | nominalSecs=${nominalEnd.toFixed(3)}`);
        }
    }
    lastCycle = cycleIndex;

    if (cyclePos < AD_BREAK_EVERY) return;

    const adProgress = (cyclePos - AD_BREAK_EVERY) / AD_BREAK_LENGTH;

    for (const { event, pct } of QUARTILES) {
        if (adProgress < pct) break;
        const key = `${cycleIndex}:${event}`;
        if (fired.has(key)) continue;
        fired.add(key);
        // For 'start', log the nominal boundary time, not the actual frame time.
        const reportSecs = event === "start" ? cycleIndex * CYCLE_SECS + AD_BREAK_EVERY : streamSecs;
        log(`break=${cycleIndex} | ${event.padEnd(16)} | ${Math.round(pct * 100)}% | streamSecs=${reportSecs.toFixed(3)}`);
    }
}

const reportIngest = createIngestClock();
const inspector = new FMP4Inspector({ onVideoTrack: (trackId, timescale) => log(`video track ${trackId} timescale ${timescale}`) });
inspector.onVideoTimestamp = (pts) => {
    reportIngest(pts);
    onVideoTimestamp(pts);
};

log(`adBreakEvery=${AD_BREAK_EVERY} adBreakLength=${AD_BREAK_LENGTH}`);

process.stdin.on("data", (chunk) => {
    process.stdout.write(chunk);
    inspector.feed(chunk);
});

process.stdin.on("end", () => {
    process.stdout.end();
    log("stream ended");
});

process.stdin.on("error", (err) => {
    process.stderr.write(`[SSAI] stdin error: ${err.message}\n`);
    process.exit(1);
});
