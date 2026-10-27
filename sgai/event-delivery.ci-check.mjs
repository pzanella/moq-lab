#!/usr/bin/env node
// CI log verifier for SGAI event delivery: every Event Timeline record that
// ad-decisioning-publisher.mjs emitted must reach debug-subscriber.mjs. A check
// for "this line appears somewhere" passes even when one break loses an event,
// as long as another break has it; this one compares the two logs event by event.
//
// Only events emitted while the subscriber was subscribed, and at least GRACE_MS
// before --stop-ms (when CI stopped the publisher), are required: earlier ones
// may come from a cycle the subscriber never saw, later ones may still be on
// the way when the processes are stopped.
//
// Usage: node sgai/event-delivery.ci-check.mjs --publisher-log FILE \
//   --subscriber-log FILE --stop-ms EPOCH_MS
import { readFileSync } from "node:fs";
import { parseArgs } from "../lib/cli.mjs";

const GRACE_MS = 1000;

const args = parseArgs(process.argv.slice(2));
const stopMs = Number(args["stop-ms"]);
if (!args["publisher-log"] || !args["subscriber-log"] || !Number.isFinite(stopMs)) {
    console.error("usage: event-delivery.ci-check.mjs --publisher-log FILE --subscriber-log FILE --stop-ms EPOCH_MS");
    process.exit(1);
}

// Both scripts log "[prefix] <ISO time> <message>" (lib/log.mjs). An event is
// "emit <name> (event_id=N, m=M)" on one side and "RECV <name> (event_id=N, m=Mms)"
// on the other; the key is the part they share.
const LINE = /^\[[^\]]+\] (\S+) (.*)$/;

function readLog(file) {
    return readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.match(LINE))
        .filter(Boolean)
        .map(([, time, message]) => ({ ms: Date.parse(time), message }));
}

const publisher = readLog(args["publisher-log"]);
const subscriber = readLog(args["subscriber-log"]);

const subscribedAt = subscriber.find((l) => l.message.includes("subscribing to the events track"))?.ms;
if (subscribedAt === undefined) {
    console.error("FAIL: the subscriber never subscribed to the events track");
    process.exit(1);
}

const sent = publisher
    .map((l) => ({ ms: l.ms, key: l.message.match(/^emit (.* \(event_id=\d+, m=\d+)\)$/)?.[1] }))
    .filter((e) => e.key && e.ms >= subscribedAt && e.ms <= stopMs - GRACE_MS);
const received = new Set(
    subscriber.map((l) => l.message.match(/^RECV (.* \(event_id=\d+, m=\d+)ms\)$/)?.[1]).filter(Boolean),
);

const lost = sent.filter((e) => !received.has(e.key));
for (const e of lost) console.error(`LOST: ${e.key})`);
if (sent.length === 0) {
    console.error("FAIL: no events to check (did the publisher emit anything?)");
    process.exit(1);
}
console.log(`event delivery: ${sent.length - lost.length}/${sent.length} events received`);
process.exit(lost.length > 0 ? 1 : 0);
