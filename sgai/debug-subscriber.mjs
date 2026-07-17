#!/usr/bin/env node
// Isolated test harness for the SGAI Event Timeline prototype -- lets you
// verify the whole server-side pipeline from the terminal, without a
// browser or player. Subscribes to the events broadcast published by
// ad-decisioning-publisher.mjs and prints each record, plus the subscriber
// action it *would* take per the SGAI-over-MOQ spec's Subscriber Behavior
// section. No MSE/player code is touched -- console output only.
//
// Usage:
//   node debug-subscriber.mjs --url https://localhost:4443 \
//     --events-broadcast bbb-events [--content-broadcast bbb.hang] [--ad-broadcast bbb-ad.hang]
import * as Msf from "@moq/msf";
import { CATALOG_TRACK_NAME, connectRelay, Moq } from "./transport.mjs";
import { SEGMENTATION_TYPE, SEGMENTATION_TYPE_NAMES } from "./event-timeline.mjs";
import { parseArgs } from "../lib/cli.mjs";
import { createLogger } from "../lib/log.mjs";

const log = createLogger("sgai-subscriber");

const args = parseArgs(process.argv.slice(2));
const url = args.url;
const eventsBroadcast = args["events-broadcast"];
const contentBroadcast = args["content-broadcast"] ?? "<content-broadcast>";
const adBroadcast = args["ad-broadcast"] ?? "<ad-broadcast>";

if (!url || !eventsBroadcast) {
    console.error(
        "Usage: debug-subscriber.mjs --url <relayUrl> --events-broadcast <name> " +
            "[--content-broadcast <name>] [--ad-broadcast <name>]",
    );
    process.exit(1);
}

// The events broadcast may not be announced yet (publisher not started, or
// still starting up) -- subscribing before it's announced gets the stream
// reset by the relay instead of queued. Wait for the ANNOUNCE first.
async function waitForAnnounced(conn, path) {
    const announced = conn.announced(path);
    for (;;) {
        const entry = await announced.next();
        if (!entry) return false;
        if (entry.active) return true;
    }
}

let stopping = false;
process.on("SIGINT", () => {
    stopping = true;
});

while (!stopping) {
    let conn;
    try {
        conn = await connectRelay(url);
        log(`connected to ${url}, waiting for '${eventsBroadcast}' to be announced...`);

        const path = Moq.Path.from(eventsBroadcast);
        const found = await waitForAnnounced(conn, path);
        if (!found) throw new Error("announced stream ended before broadcast appeared");

        log(`'${eventsBroadcast}' is live, subscribing to the events track...`);
        const broadcast = conn.consume(path);

        // Sanity-check the catalog through the real MSF schema (Msf.decode() runs
        // inside Msf.fetch()) instead of trusting the publisher's raw JSON on faith.
        const catalogTrack = broadcast.subscribe(CATALOG_TRACK_NAME, 0);
        const catalog = await Msf.fetch(catalogTrack);
        if (catalog) {
            log(`catalog: ${catalog.tracks.map((t) => `${t.name} (${t.packaging})`).join(", ")}`);
        } else {
            log("catalog track closed before a snapshot arrived");
        }

        const eventsTrack = broadcast.subscribe("events", 0);

        while (!stopping) {
            const record = await eventsTrack.readJson();
            if (record === undefined) {
                log("track closed by publisher, exiting");
                stopping = true;
                break;
            }

            const { m, data } = record;
            const typeName = SEGMENTATION_TYPE_NAMES[data.segmentation_type_id] ?? data.segmentation_type_id;
            log(`RECV ${typeName} (event_id=${data.segmentation_event_id}, m=${m}ms)`);

            switch (data.segmentation_type_id) {
                case SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_START:
                    log(`  [would] UNSUBSCRIBE content ('${contentBroadcast}')`);
                    break;
                case SEGMENTATION_TYPE.PROVIDER_ADVERTISEMENT_START:
                    log(`  [would] FETCH ad ('${data.segmentation_upid_uri ?? adBroadcast}')`);
                    break;
                case SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_END:
                    log(`  [would] RESUBSCRIBE content ('${contentBroadcast}')`);
                    break;
                default:
                    break;
            }
        }
    } catch (err) {
        log(`connection error: ${err.message ?? err}`);
        if (!stopping) {
            log("retrying in 2s (events broadcast may not be announced yet)...");
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    } finally {
        conn?.close();
    }
}
