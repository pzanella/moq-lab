#!/usr/bin/env node
// The "MOQ Ad Decisioning Publisher" from the SGAI-over-MOQ architecture.
//
// Runs on the host (not inside the Docker sandbox). Connects to the relay
// started by stream.sh --sgai-mode and publishes a third, independent
// broadcast carrying an org.scte.scte35.v1 Event Timeline: SCTE-35-shaped
// JSON records signaling when to switch between the content and ad
// broadcasts. Ad-break timing is schedule-based (ad-break-every / ad-break-length),
// not derived from parsing media timestamps.
//
// It also owns the ad broadcast's lifecycle: at the start of every ad break it
// `docker exec`s a fresh, single-shot `ffmpeg | moq import` into the sandbox
// container, so the ad always starts at its own frame 0 instead of wherever a
// continuously-looping stream happened to be when the break began.
//
// Usage:
//   node ad-decisioning-publisher.mjs --url https://localhost:4443 \
//     --content-broadcast bbb.hang --ad-broadcast bbb-ad.hang \
//     --events-broadcast bbb-events --ad-break-every 30 --ad-break-length 15 \
//     --container-name moq-stream-1234 --relay-port 4443 --ad-file /tmp/ad_normalized.mp4
import { spawn } from "node:child_process";
import * as Msf from "@moq/msf";
import { CATALOG_TRACK_NAME, connectRelay, Moq } from "./transport.mjs";
import { placementOpportunityStart, placementOpportunityEnd, adStart, adEnd, SEGMENTATION_TYPE_NAMES } from "./event-timeline.mjs";
import { parseArgs } from "../lib/cli.mjs";
import { createLogger } from "../lib/log.mjs";

const log = createLogger("ad-decisioning");

function fail(msg) {
    console.error(`[ad-decisioning] ${msg}`);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const url = args.url;
const contentBroadcast = args["content-broadcast"];
const adBroadcast = args["ad-broadcast"];
const eventsBroadcast = args["events-broadcast"];
const adBreakEvery = Number(args["ad-break-every"] ?? 30);
const adBreakLength = Number(args["ad-break-length"]);
const containerName = args["container-name"];
const relayPort = args["relay-port"];
const adFile = args["ad-file"] ?? "/tmp/ad_normalized.mp4";

for (const [flag, value] of [
    ["--url", url],
    ["--content-broadcast", contentBroadcast],
    ["--ad-broadcast", adBroadcast],
    ["--events-broadcast", eventsBroadcast],
    ["--container-name", containerName],
    ["--relay-port", relayPort],
]) {
    if (!value) fail(`missing required ${flag}`);
}
if (!Number.isFinite(adBreakEvery) || adBreakEvery <= 0) fail("--ad-break-every must be a positive number");
if (!Number.isFinite(adBreakLength) || adBreakLength <= 0) fail("--ad-break-length must be a positive number");

const cycleSecs = adBreakEvery + adBreakLength;

// `adBroadcast` (e.g. "bbb-ad.hang") is a base name, not the literal broadcast published on the
// wire. Each ad break gets its own uniquely-named broadcast (see cycleAdBroadcast()) instead of
// reusing one name across a kill+restart -- see the comment on stopAd() for why reuse is unsafe.
// The base's own ".hang" suffix (hang's catalog-format convention) is preserved on the per-cycle
// name rather than stripped, so each one is independently well-formed.
function cycleAdBroadcast(cycle) {
    return adBroadcast.replace(/(\.hang)?$/, (suffix) => `-${cycle}${suffix}`);
}

// A subscriber resolves the actual broadcast to fetch from this URI, per the
// SCTE-35 upid_uri's real purpose: pointing at where to fetch *this* specific
// ad. The scheme/host are informal; only the last path segment is read.
function adUpidUri(cycle) {
    return `moqt://localhost/${cycleAdBroadcast(cycle)}`;
}

const conn = await connectRelay(url);
log(`connected to ${url}`);

const broadcast = new Moq.Broadcast();
conn.publish(Moq.Path.from(eventsBroadcast), broadcast);

// MSF (draft-ietf-moq-msf-01) catalog: "eventtimeline" is a real, schema-validated
// packaging value (see @moq/msf's PackagingSchema), unlike the ad-hoc JSON this used
// to write. `role` is omitted -- it's a separate video/audio/caption/... enum, and the
// draft's own timeline-track examples leave it unset. `depends`, `mimetype`, and
// `eventType` aren't modeled by @moq/msf yet (its TrackSchema doesn't declare them), so
// they ride along on the wire via Msf.encode()'s plain object spread but would be
// stripped by a strict Msf.decode() -- read raw by debug-subscriber.mjs for now.
const catalogBytes = Msf.encode({
    tracks: [
        {
            name: "events",
            namespace: eventsBroadcast,
            packaging: "eventtimeline",
            mimetype: "application/json",
            depends: [contentBroadcast],
            eventType: "org.scte.scte35.v1",
            isLive: true,
        },
    ],
});

// `broadcast.subscribe(name, priority)` only pre-registers a *local* Track -- it does not
// bind to whatever Track a real network SUBSCRIBE later gets. Confirmed against a live relay:
// a producer that calls subscribe() once at startup and writes to that Track forever never
// delivers a single frame to any real subscriber, because the wire layer calls subscribe()
// itself for each incoming SUBSCRIBE (see @moq/net's lite/publisher.ts runSubscribe), handing
// back a *different* Track instance that only shares the name. The correct pattern (see
// @moq/net's examples/publish.ts) is to react to broadcast.requested() and write to the Track
// that request actually carries, once per subscriber.
const eventsTracks = [];

(async () => {
    for (;;) {
        const request = await broadcast.requested();
        if (!request) break;

        if (request.track.name === CATALOG_TRACK_NAME) {
            // The catalog is a one-shot snapshot: write it once per subscriber, mirroring
            // hang's json Producer.serve() seeding each new subscriber directly. Left open
            // rather than closed immediately -- closing the track right after writing races
            // the async, fire-and-forget group delivery in @moq/net's publisher and can tear
            // down the group's stream before the frame reaches the subscriber (RESET_STREAM).
            request.track.writeFrame(catalogBytes);
        } else if (request.track.name === "events") {
            eventsTracks.push(request.track);
        } else {
            request.track.close(new Error(`unknown track: ${request.track.name}`));
        }
    }
})();

function emit(record) {
    for (let i = eventsTracks.length - 1; i >= 0; i--) {
        try {
            eventsTracks[i].writeJson(record);
        } catch {
            // Subscriber disconnected; drop it rather than let it break future emits.
            eventsTracks.splice(i, 1);
        }
    }
    const name = SEGMENTATION_TYPE_NAMES[record.data.segmentation_type_id] ?? record.data.segmentation_type_id;
    log(`emit ${name} (event_id=${record.data.segmentation_event_id}, m=${record.m})`);
}

// Launches a single playthrough of the ad, from its own frame 0, as a detached process inside
// the sandbox container, publishing under this cycle's own unique broadcast name.
function publishAdOnce(broadcastName) {
    const cmd = `ffmpeg -hide_banner -v quiet -re -i "${adFile}" -c copy ` +
        `-f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_every_frame - | ` +
        `moq --client-connect "http://localhost:${relayPort}" --broadcast "${broadcastName}" import fmp4`;
    const proc = spawn("docker", ["exec", "-d", containerName, "sh", "-c", cmd], { stdio: "ignore" });
    proc.on("error", (err) => log(`failed to launch ad publish: ${err.message}`));
}

// ffmpeg exits on its own once the file reaches EOF, but moq doesn't close its relay
// connection on stdin EOF -- it lingers until the relay's own idle timeout. Since every ad break
// uses its own unique broadcast name (see cycleAdBroadcast()), a lingering old session can never
// be confused with a new one, so this is purely resource hygiene (freeing the container's CPU
// and the relay's connection slot), not a correctness requirement -- no need to wait for it.
function stopAd(broadcastName) {
    const cmd = `pkill -f 'broadcast ${broadcastName} import fmp4' || true`;
    const proc = spawn("docker", ["exec", "-d", containerName, "sh", "-c", cmd], { stdio: "ignore" });
    proc.on("error", (err) => log(`failed to stop ad publish: ${err.message}`));
}

log(`schedule: ${adBreakEvery}s content -> ${adBreakLength}s ad, repeating. events broadcast: '${eventsBroadcast}'`);

let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

const startedAt = Date.now();
async function sleepUntil(targetMs) {
    const delay = targetMs - (Date.now() - startedAt);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

let cycle = 0;
while (running) {
    const poEventId = 1000 + cycle;
    const adEventId = 2000 + cycle;
    const breakStartMs = cycle * cycleSecs * 1000 + adBreakEvery * 1000;
    const breakEndMs = breakStartMs + adBreakLength * 1000;

    const cycleAdBroadcastName = cycleAdBroadcast(cycle);

    await sleepUntil(breakStartMs);
    if (!running) break;
    publishAdOnce(cycleAdBroadcastName);
    // adStart must be written (and observed) before placementOpportunityStart: a subscriber is
    // expected to treat this pair as one atomic trigger, acting on whichever record arrives
    // first -- but only adStart carries segmentation_upid_uri (the per-cycle broadcast name to
    // fetch), so if placementOpportunityStart won the race, the subscriber would act with no
    // broadcast name to resolve. Writing them back-to-back with no gap isn't enough on its own:
    // two independent single-frame groups appended in the same tick can race each other to the
    // subscriber, and whichever loses can arrive after the other or be skipped over entirely --
    // see the identical gap on the End pair below. A short stagger gives the first write a clear
    // head start instead of leaving the order to chance.
    emit(adStart(breakStartMs, adEventId, adUpidUri(cycle)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    emit(placementOpportunityStart(breakStartMs, poEventId));

    await sleepUntil(breakEndMs);
    if (!running) break;
    emit(adEnd(breakEndMs, adEventId));
    await new Promise((resolve) => setTimeout(resolve, 50));
    emit(placementOpportunityEnd(breakEndMs, poEventId));
    stopAd(cycleAdBroadcastName);

    cycle += 1;
}

log("shutting down");
conn.close();
