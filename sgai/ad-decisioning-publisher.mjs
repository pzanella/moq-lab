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
// It also observes the real content track to publish a Media Timeline (see
// sgai/media-timeline.mjs) and, optionally, a one-shot regional-blackout demo
// (Program Blackout Override) and %token%-templated ad upids (see
// lib/msf-uri.mjs).
//
// Usage:
//   node ad-decisioning-publisher.mjs --url https://localhost:4443 \
//     --content-broadcast bbb.hang --ad-broadcast bbb-ad.hang \
//     --events-broadcast bbb-events --ad-break-every 30 --ad-break-length 15 \
//     --container-name moq-stream-1234 --relay-port 4443 --ad-file /tmp/ad_normalized.mp4 \
//     [--blackout-at 45] [--blackout-length 10] [--blackout-alt-upid moqt://localhost/alt.hang] \
//     [--upid-token-template true]
import { spawn } from "node:child_process";
import * as Msf from "@moq/msf";
import { CATALOG_TRACK_NAME, connectRelay, Moq, waitForAnnounced } from "./transport.mjs";
import {
    placementOpportunityStart,
    placementOpportunityEnd,
    adStart,
    adEnd,
    programBlackoutOverride,
    SEGMENTATION_TYPE_NAMES,
} from "./event-timeline.mjs";
import { resolveVideoTiming, mediaTimelineEntry } from "./media-timeline.mjs";
import { buildUri } from "../lib/msf-uri.mjs";
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
// Optional regional-blackout demo (SGAI-over-MOQ spec section 4.2): fires once,
// blackoutAt seconds into the run, restoring after blackoutLength seconds.
const blackoutAt = args["blackout-at"] !== undefined ? Number(args["blackout-at"]) : null;
const blackoutLength = Number(args["blackout-length"] ?? 10);
const blackoutAltUpid = args["blackout-alt-upid"] ?? buildUri({ endpoint: "moqt://localhost", namespace: "blackout-alt-content.hang" });
// Optional demo of draft-ietf-moq-msf's URI-fragment %variable% substitution:
// appends a %token%-templated query param to the ad upid_uri, for a subscriber
// (see debug-subscriber.mjs's --token) to resolve client-side.
const upidTokenTemplate = args["upid-token-template"] === "true";

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
if (blackoutAt !== null && (!Number.isFinite(blackoutAt) || blackoutAt < 0)) fail("--blackout-at must be a non-negative number");
if (blackoutAt !== null && (!Number.isFinite(blackoutLength) || blackoutLength <= 0)) fail("--blackout-length must be a positive number");

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
// ad. `ns=` carries the per-cycle broadcast name (see buildUri() in
// lib/msf-uri.mjs); `t=` is omitted since moq-cli only assigns the ad
// broadcast's actual track name once it starts publishing, not something
// known here in advance. With --upid-token-template, a %token% placeholder
// rides along in the query string for a subscriber to resolve -- orthogonal
// to the per-cycle broadcast name, which solves a different problem (safe
// reuse across kill+restart, not personalization).
function adUpidUri(cycle) {
    const base = buildUri({ endpoint: "moqt://localhost", namespace: cycleAdBroadcast(cycle) });
    return upidTokenTemplate ? `${base}&tok=%token%` : base;
}

const conn = await connectRelay(url);
log(`connected to ${url}`);

// Declared early -- the Media Timeline observer below (an async IIFE that
// starts running immediately, well before the ad-break loop further down)
// checks this in its own loops so a shutdown signal can actually stop it
// instead of leaving a zombie process behind.
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

const broadcast = new Moq.Broadcast.Producer();
conn.publish(Moq.Path.from(eventsBroadcast), broadcast);

// MSF (draft-ietf-moq-msf-01) catalog: "eventtimeline"/"mediatimeline" are real,
// schema-validated packaging values (see @moq/msf's PackagingSchema), unlike the
// ad-hoc JSON this used to write. `role` is omitted -- it's a separate
// video/audio/caption/... enum, and the draft's own timeline-track examples leave
// it unset. `depends`, `mimetype`, and `eventType` aren't modeled by @moq/msf yet
// (its TrackSchema doesn't declare them), so they ride along on the wire via
// Msf.encode()'s plain object spread but would be stripped by a strict
// Msf.decode() -- read raw by debug-subscriber.mjs for now.
//
// "events" depends on "mediatime", a real co-published track (see below) --
// not the content broadcast's name, which was never a valid track reference.
const catalogBytes = Msf.encode({
    tracks: [
        {
            name: "events",
            namespace: eventsBroadcast,
            packaging: "eventtimeline",
            mimetype: "application/json",
            depends: ["mediatime"],
            eventType: "org.scte.scte35.v1",
            isLive: true,
        },
        {
            name: "mediatime",
            namespace: eventsBroadcast,
            packaging: "mediatimeline",
            mimetype: "application/json",
            isLive: true,
        },
    ],
});

// `broadcast.subscribe(name, options)` only pre-registers a *local* Track -- it does not
// bind to whatever Track a real network SUBSCRIBE later gets. Confirmed against a live relay:
// a producer that calls subscribe() once at startup and writes to that Track forever never
// delivers a single frame to any real subscriber, because the wire layer calls subscribe()
// itself for each incoming SUBSCRIBE (see @moq/net's lite/publisher.ts runSubscribe), handing
// back a *different* Track instance that only shares the name. The correct pattern (see
// @moq/net's examples/publish.ts) is to react to broadcast.requested() and accept() the
// Track.Request it actually carries, once per subscriber.
const eventsTracks = [];
const mediaTimeTracks = [];

(async () => {
    for (;;) {
        const request = await broadcast.requested();
        if (!request) break;

        if (request.name === CATALOG_TRACK_NAME) {
            // The catalog is a one-shot snapshot: write it once per subscriber, mirroring
            // hang's json Producer.serve() seeding each new subscriber directly. Left open
            // rather than closed immediately -- closing the track right after writing races
            // the async, fire-and-forget group delivery in @moq/net's publisher and can tear
            // down the group's stream before the frame reaches the subscriber (RESET_STREAM).
            // The catalog has no presentation time of its own, so Timestamp.now() is the
            // right timestamp for a control-plane payload like this one.
            const producer = request.accept();
            producer.writeFrame({ payload: catalogBytes, timestamp: Moq.Time.Timestamp.now() });
        } else if (request.name === "events") {
            eventsTracks.push(request.accept());
        } else if (request.name === "mediatime") {
            mediaTimeTracks.push(request.accept());
        } else {
            request.reject(new Error(`unknown track: ${request.name}`));
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

function emitMediaTimelineEntry(entry) {
    for (let i = mediaTimeTracks.length - 1; i >= 0; i--) {
        try {
            mediaTimeTracks[i].writeJson(entry);
        } catch {
            mediaTimeTracks.splice(i, 1);
        }
    }
}

// Media Timeline: observes the real content broadcast (subscribing never affects
// its playback) to publish genuine [mediaTimeMs, [group, object], wallClockMs]
// entries -- one per Group (object 0, i.e. each keyframe/GOP), matching the
// spec's own illustrative sampling cadence. This is the only part of this
// script that reads real media timestamps instead of working off the
// ad-break wall-clock schedule.
//
// Simplification: this lives on the events broadcast (co-published with the
// Event Timeline, both under eventsBroadcast) rather than on the Media
// Publisher's own broadcast as the architecture slides show -- this sandbox's
// content publish is `moq import fmp4` (an off-the-shelf binary this repo
// doesn't control), not something we can attach an extra track to directly.
(async () => {
    let timing;
    while (running) {
        try {
            timing = await resolveVideoTiming(url, contentBroadcast);
            break;
        } catch (err) {
            log(`waiting for '${contentBroadcast}' catalog (${err.message})...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    if (!running) return;
    log(
        `observing '${contentBroadcast}/${timing.trackName}' for the Media Timeline ` +
            `(videoTrackId=${timing.videoTrackId}, timescale=${timing.timescale})`,
    );

    const contentPath = Moq.Path.from(contentBroadcast);
    const found = await waitForAnnounced(conn, contentPath);
    if (!running) return;
    if (!found) {
        log(`'${contentBroadcast}' was never announced; Media Timeline disabled`);
        return;
    }
    const contentTrack = conn.consume(contentPath).subscribe(timing.trackName, { priority: 0 });

    while (running) {
        const object = await contentTrack.readFrameSequence();
        if (!object) {
            log("content track closed; Media Timeline stopped");
            return;
        }
        if (object.frame !== 0) continue; // one entry per Group (keyframe), not per frame
        const entry = mediaTimelineEntry(object, timing.videoTrackId, timing.timescale);
        if (entry) emitMediaTimelineEntry(entry);
    }
})();

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

const startedAt = Date.now();
async function sleepUntil(targetMs) {
    const delay = targetMs - (Date.now() - startedAt);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

// Regional blackout demo (SGAI-over-MOQ spec section 4.2): a one-shot
// Program Blackout Override at blackoutAt, restored at blackoutAt+blackoutLength.
// Runs concurrently with the ad-break loop below, sharing the same startedAt
// epoch and running flag -- independent of the ad-break schedule/event ids.
if (blackoutAt !== null) {
    const BLACKOUT_EVENT_ID = 5000;
    (async () => {
        await sleepUntil(blackoutAt * 1000);
        if (!running) return;
        emit(programBlackoutOverride(blackoutAt * 1000, BLACKOUT_EVENT_ID, { blackedOut: true, alternateUpid: blackoutAltUpid }));
        await sleepUntil((blackoutAt + blackoutLength) * 1000);
        if (!running) return;
        emit(programBlackoutOverride((blackoutAt + blackoutLength) * 1000, BLACKOUT_EVENT_ID, { blackedOut: false }));
    })();
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
