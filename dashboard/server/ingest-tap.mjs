#!/usr/bin/env node
// Dashboard-only pass-through tap for the plain fMP4 pipeline (base stream and
// SGAI content), which otherwise has no proxy of its own between ffmpeg and
// `moq import`. SSAI and CSAI already have one (impression-tracker.mjs,
// ts-injector.mjs) and report the ingest clock from there instead.
// Usage: ffmpeg ... | node ingest-tap.mjs | moq ... import fmp4
import { FMP4Inspector } from "../../lib/fmp4.mjs";
import { createIngestClock } from "../../lib/ingest-clock.mjs";

const inspector = new FMP4Inspector();
inspector.onVideoTimestamp = createIngestClock();

// Honor backpressure: if this read ahead of a slower `moq import`, the ingest
// clock would record when ffmpeg produced a frame instead of when it was
// actually handed to the publisher, and the backlog would pile up in memory.
process.stdin.on("data", (chunk) => {
    if (!process.stdout.write(chunk)) {
        process.stdin.pause();
        process.stdout.once("drain", () => process.stdin.resume());
    }
    inspector.feed(chunk);
});

process.stdin.on("end", () => process.stdout.end());

process.stdin.on("error", (err) => {
    process.stderr.write(`[dashboard] ingest-tap stdin error: ${err.message}\n`);
    process.exit(1);
});
