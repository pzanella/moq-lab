#!/usr/bin/env node
// CI log verifier for ssai/impression-tracker.mjs -- reads a container's
// combined stdout/stderr on stdin and checks the full quartile-event sequence
// for two consecutive run-stream.sh passes (the "while true" restart loop
// around impression-tracker.mjs), asserting order and plausible timing, not
// just "this substring appears somewhere in the log". A bare substring check
// wouldn't catch events firing out of order, a wrong break index, or the
// break counter failing to reset to 0 when a fresh pass starts.
//
// Usage: docker logs <container> | node ssai/impression-tracker.ci-check.mjs <adBreakEvery> <cyclesPerPass>
import { createInterface } from "node:readline";

const AD_BREAK_EVERY = Number(process.argv[2]);
const CYCLES_PER_PASS = Number(process.argv[3]);
if (!Number.isFinite(AD_BREAK_EVERY) || !Number.isInteger(CYCLES_PER_PASS) || CYCLES_PER_PASS < 1) {
    console.error("usage: impression-tracker.ci-check.mjs <adBreakEvery> <cyclesPerPass>");
    process.exit(1);
}

const lines = [];
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => lines.push(line));
await new Promise((resolve) => rl.on("close", resolve));

let fail = 0;
let cursor = 0; // strictly-increasing index into `lines` -- enforces ordering

// Scans forward from `cursor` (never backward), stopping before `limit`, for
// the first line `matcher` accepts, and advances `cursor` past it. Returns
// matcher's return value, or null (and records a failure) if nothing in
// [cursor, limit) matches.
//
// `limit` matters as much as the forward-only scan does: without it, a line
// swapped out of order *within* a pass can still be "found" by matching the
// analogous line from the *next* pass instead (passes repeat the same event
// sequence), silently passing instead of catching the reorder.
function next(matcher, label, limit = lines.length) {
    for (let i = cursor; i < limit; i++) {
        const m = matcher(lines[i]);
        if (m) {
            cursor = i + 1;
            return m;
        }
    }
    console.log(`FAIL  ${label}: not found in lines [${cursor}, ${limit})`);
    fail = 1;
    return null;
}

function checkNear(label, actual, expected, tolerance) {
    if (actual === undefined || Math.abs(actual - expected) > tolerance) {
        console.log(`FAIL  ${label}: got ${actual}, expected ~${expected.toFixed(3)} (±${tolerance})`);
        fail = 1;
        return;
    }
    console.log(`PASS  ${label}: ${actual} (expected ~${expected.toFixed(3)} ±${tolerance})`);
}

function checkExact(label, actual, expected, epsilon = 0.01) {
    if (actual === undefined || Math.abs(actual - expected) > epsilon) {
        console.log(`FAIL  ${label}: got ${actual}, expected ${expected.toFixed(3)}`);
        fail = 1;
        return;
    }
    console.log(`PASS  ${label}: ${actual}`);
}

// "start" is logged from the nominal cycle boundary (cycleIndex * CYCLE_SECS +
// AD_BREAK_EVERY), not the actual frame PTS, so it's checked exactly. The
// quartiles in between are logged from the actual decoded frame PTS, which
// lands on whichever frame's timestamp first crosses the threshold -- within
// one frame interval of the nominal value, hence the wider tolerance.
const QUARTILE_TOLERANCE = 0.5;

function findRestartMarker(fromIndex) {
    for (let i = fromIndex; i < lines.length; i++) {
        if (lines[i].includes("SSAI: pass complete, restarting...")) return i;
    }
    return lines.length; // no marker yet (e.g. the pass under test is the last one captured)
}

function runOnePass(passLabel) {
    const startup = next((l) => {
        const m = l.match(/adBreakEvery=([\d.]+) adBreakLength=([\d.]+)/);
        return m ? { adBreakEvery: Number(m[1]), adBreakLength: Number(m[2]) } : null;
    }, `${passLabel}: startup log line`);
    if (!startup) return;

    // Bound every check in this pass to before the next restart marker, so a
    // line reordered within the pass can't be matched against the structurally
    // identical line from whatever pass comes after it.
    const limit = findRestartMarker(cursor);
    const cycleSecs = AD_BREAK_EVERY + startup.adBreakLength;

    for (let breakIndex = 0; breakIndex < CYCLES_PER_PASS; breakIndex++) {
        const base = breakIndex * cycleSecs;

        const start = next((l) => {
            const m = l.match(new RegExp(`break=${breakIndex} \\| start\\s*\\| 0% \\| streamSecs=([\\d.]+)`));
            return m ? { streamSecs: Number(m[1]) } : null;
        }, `${passLabel}: break=${breakIndex} start`, limit);
        if (start) checkExact(`${passLabel}: break=${breakIndex} start streamSecs`, start.streamSecs, base + AD_BREAK_EVERY);

        for (const [event, pct] of [
            ["first_quartile", 0.25],
            ["midpoint", 0.5],
            ["third_quartile", 0.75],
        ]) {
            const found = next((l) => {
                const m = l.match(
                    new RegExp(`break=${breakIndex} \\| ${event}\\s*\\| ${Math.round(pct * 100)}% \\| streamSecs=([\\d.]+)`),
                );
                return m ? { streamSecs: Number(m[1]) } : null;
            }, `${passLabel}: break=${breakIndex} ${event}`, limit);
            if (found) {
                const expected = base + AD_BREAK_EVERY + pct * startup.adBreakLength;
                checkNear(`${passLabel}: break=${breakIndex} ${event} streamSecs`, found.streamSecs, expected, QUARTILE_TOLERANCE);
            }
        }

        // 'complete' fires on cycle advance (impression-tracker.mjs), which
        // needs a video timestamp from the *next* cycle to observe -- the
        // last cycle in a pass has no next cycle before the ffmpeg process
        // (and with it, this pass) ends, so it never gets a 'complete' line.
        // Only cycles before the last one in each pass emit it.
        if (breakIndex < CYCLES_PER_PASS - 1) {
            const complete = next((l) => {
                const m = l.match(new RegExp(`break=${breakIndex} \\| complete\\s*\\| 100% \\| nominalSecs=([\\d.]+)`));
                return m ? { nominalSecs: Number(m[1]) } : null;
            }, `${passLabel}: break=${breakIndex} complete`, limit);
            if (complete) checkExact(`${passLabel}: break=${breakIndex} complete nominalSecs`, complete.nominalSecs, base + cycleSecs);
        }
    }

    // The critical assertion of the restart check: the *next* pass must start
    // back at break=0, not continue as break=2 -- runOnePass's next call
    // looks for break=0/break=1 again, so if the counter carried over instead
    // of resetting, that whole next call fails to find anything.
    next((l) => l.includes("SSAI: pass complete, restarting..."), `${passLabel}: restart marker`);
}

runOnePass("pass 1");
runOnePass("pass 2");

if (fail) {
    console.log(`FAIL  ${lines.length} log lines scanned, cursor ended at ${cursor}`);
} else {
    console.log(`PASS  all checks passed (${lines.length} log lines scanned)`);
}
process.exit(fail);
