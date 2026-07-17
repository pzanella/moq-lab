#!/usr/bin/env node
// SSAI impression tracker — transparent fMP4 pipeline proxy.
// Usage: ffmpeg ... | node impression-tracker.mjs <adBreakEvery> <adBreakLength> | moq import fmp4
//
// Reads raw fMP4 from stdin, passes every byte unchanged to stdout,
// and logs impression events when the stream PTS crosses ad quartile thresholds.
import { createLogger } from "../lib/log.mjs";

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

// 'complete' fires when the cycle index advances, not from a quartile, because modulo can never reach CYCLE_SECS.
const QUARTILES = [
    { event: "start", pct: 0 },
    { event: "first_quartile", pct: 0.25 },
    { event: "midpoint", pct: 0.5 },
    { event: "third_quartile", pct: 0.75 },
];

// ---------------------------------------------------------------------------
// fMP4 inspector: parses moof/tfdt timestamps from the video track.
// Works on a private copy of the data so stdout is never delayed.
// ---------------------------------------------------------------------------

class FMP4Inspector {
    constructor() {
        this._buf = Buffer.alloc(0);
        this._skipBytes = 0; // bytes left to discard for current mdat/ftyp/…
        this._timescales = new Map(); // trackId → timescale
        this._videoTrackId = null;
        this.onVideoTimestamp = null; // (secs: number) => void
    }

    feed(chunk) {
        if (this._skipBytes > 0) {
            if (chunk.length <= this._skipBytes) {
                this._skipBytes -= chunk.length;
                return;
            }
            chunk = chunk.subarray(this._skipBytes);
            this._skipBytes = 0;
        }
        this._buf = Buffer.concat([this._buf, chunk]);
        this._parse();
    }

    // When rawSize === 1, the spec uses a 64-bit "largesize" at bytes 8-15.
    static _boxHeader(buf, off) {
        const rawSize = buf.readUInt32BE(off);
        if (rawSize === 1) {
            if (buf.length < off + 16) return null; // incomplete, wait
            const hi = buf.readUInt32BE(off + 8);
            const lo = buf.readUInt32BE(off + 12);
            return { size: hi * 0x100000000 + lo, headerSize: 16 };
        }
        return { size: rawSize, headerSize: 8 };
    }

    _parse() {
        while (this._buf.length >= 8) {
            const hdr = FMP4Inspector._boxHeader(this._buf, 0);
            if (!hdr) break;
            const { size, headerSize } = hdr;

            const type = this._buf.subarray(4, 8).toString("ascii");
            if (size < headerSize) {
                this._buf = this._buf.subarray(headerSize);
                continue;
            }

            // Skip large leaf boxes without buffering their bodies.
            if (type === "mdat" || type === "ftyp" || type === "styp" || type === "free" || type === "skip") {
                const bodySize = size - headerSize;
                const have = this._buf.length - headerSize;
                const eat = Math.min(bodySize, have);
                this._buf = this._buf.subarray(headerSize + eat);
                this._skipBytes = bodySize - eat;
                continue;
            }

            if (this._buf.length < size) break; // wait for the full box

            const body = this._buf.subarray(headerSize, size);
            this._buf = this._buf.subarray(size);

            if (type === "moov") this._parseMoov(body);
            else if (type === "moof") this._parseMoof(body);
        }
    }

    _scanBoxes(buf, handlers) {
        let off = 0;
        while (off + 8 <= buf.length) {
            const hdr = FMP4Inspector._boxHeader(buf, off);
            if (!hdr) break;
            const { size, headerSize } = hdr;
            if (size < headerSize || off + size > buf.length) break;
            const type = buf.subarray(off + 4, off + 8).toString("ascii");
            handlers[type]?.(buf.subarray(off + headerSize, off + size));
            off += size;
        }
    }

    _parseMoov(body) {
        this._scanBoxes(body, {
            trak: (b) => {
                let trackId = null,
                    timescale = null,
                    isVideo = false;
                this._scanBoxes(b, {
                    tkhd: (tb) => {
                        // track_ID is at offset 12 (version 0) or 20 (version 1)
                        const off = tb[0] === 1 ? 20 : 12;
                        if (tb.length >= off + 4) trackId = tb.readUInt32BE(off);
                    },
                    mdia: (mb) => {
                        this._scanBoxes(mb, {
                            mdhd: (db) => {
                                // timescale is at offset 12 (version 0) or 20 (version 1)
                                const off = db[0] === 1 ? 20 : 12;
                                if (db.length >= off + 4) timescale = db.readUInt32BE(off);
                            },
                            hdlr: (hb) => {
                                // handler_type is 4 bytes at offset 8 (after version+flags+pre_defined)
                                if (hb.length >= 12) isVideo = hb.subarray(8, 12).toString() === "vide";
                            },
                        });
                    },
                });
                if (trackId !== null && timescale !== null) {
                    this._timescales.set(trackId, timescale);
                    if (isVideo && this._videoTrackId === null) {
                        this._videoTrackId = trackId;
                        log(`video track ${trackId} timescale ${timescale}`);
                    }
                }
            },
        });
    }

    _parseMoof(body) {
        this._scanBoxes(body, {
            traf: (b) => {
                let trackId = null,
                    decodeTime = null;
                this._scanBoxes(b, {
                    tfhd: (tb) => {
                        if (tb.length >= 8) trackId = tb.readUInt32BE(4);
                    },
                    tfdt: (tb) => {
                        if (tb.length < 8) return;
                        // base_media_decode_time: 4 bytes (version 0) or 8 bytes (version 1)
                        decodeTime = tb[0] === 1 ? Number(tb.readBigUInt64BE(4)) : tb.readUInt32BE(4);
                    },
                });
                if (trackId !== null && trackId === this._videoTrackId && decodeTime !== null) {
                    const timescale = this._timescales.get(trackId) ?? 90000;
                    this.onVideoTimestamp?.(decodeTime / timescale);
                }
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Impression tracking — driven entirely by stream PTS, no timers
// ---------------------------------------------------------------------------

const fired = new Set();
let lastPts = -1;
let ptsBase = 0;
let lastCycle = -1; // tracks cycle transitions to fire 'complete'

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

    // 'complete' fires when we enter the next cycle. Use the nominal end time so the log is accurate.
    if (lastCycle >= 0 && cycleIndex > lastCycle) {
        const key = `${lastCycle}:complete`;
        if (!fired.has(key)) {
            fired.add(key);
            const nominalEnd = (lastCycle + 1) * CYCLE_SECS;
            log(`break=${lastCycle} | ${"complete".padEnd(16)} | 100% | nominalSecs=${nominalEnd.toFixed(3)}`);
        }
    }
    lastCycle = cycleIndex;

    if (cyclePos < AD_BREAK_EVERY) return; // still in the content segment

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

// ---------------------------------------------------------------------------
// Pipeline: stdin → stdout (passthrough) + inspector
// ---------------------------------------------------------------------------

const inspector = new FMP4Inspector();
inspector.onVideoTimestamp = onVideoTimestamp;

log(`adBreakEvery=${AD_BREAK_EVERY} adBreakLength=${AD_BREAK_LENGTH}`);

process.stdin.on("data", (chunk) => {
    process.stdout.write(chunk); // passthrough first, inspect after
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
