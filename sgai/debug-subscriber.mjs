#!/usr/bin/env node
// Isolated test harness for the SGAI Event Timeline prototype -- lets you
// verify the whole server-side pipeline from the terminal, without a
// browser or player. Subscribes to the events broadcast published by
// ad-decisioning-publisher.mjs and prints each record, plus the subscriber
// action it *would* take per the SGAI-over-MOQ spec's Subscriber Behavior
// section. No MSE/player code is touched -- console output only.
//
// Usage:
//   node debug-subscriber.mjs --url "https://localhost:4443#token=XYZ789" \
//     --events-broadcast bbb-events [--content-broadcast bbb.hang] [--ad-broadcast bbb-ad.hang]
//
// A URI fragment on --url (e.g. "#token=XYZ789") is parsed exactly like a real
// player would parse its own connection URL's fragment, and resolved against
// any %token% placeholder found in a received record (draft-ietf-moq-msf's
// Variable Substitution section; see sgai/msf-uri.mjs). The fragment is
// client-side only, so it rides along on --url without affecting the
// connection itself.
import * as Msf from "@moq/msf";
import { CATALOG_TRACK_NAME, connectRelay, Moq, waitForAnnounced } from "./transport.mjs";
import { SEGMENTATION_TYPE, SEGMENTATION_TYPE_NAMES } from "./event-timeline.mjs";
import { parseFragmentVars, substitute } from "./msf-uri.mjs";
import { parseArgs } from "../lib/cli.mjs";
import { createLogger } from "../lib/log.mjs";

const log = createLogger("sgai-subscriber");

const args = parseArgs(process.argv.slice(2));
const url = args.url;
const eventsBroadcast = args["events-broadcast"];
const contentBroadcast = args["content-broadcast"] ?? "<content-broadcast>";
const adBroadcast = args["ad-broadcast"] ?? "<ad-broadcast>";
const templateVars = url ? parseFragmentVars(url) : {};

if (!url || !eventsBroadcast) {
    console.error(
        "Usage: debug-subscriber.mjs --url <relayUrl> --events-broadcast <name> " +
            "[--content-broadcast <name>] [--ad-broadcast <name>]",
    );
    process.exit(1);
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
        const catalogTrack = broadcast.subscribe(CATALOG_TRACK_NAME, { priority: 0 });
        const catalog = await Msf.fetch(catalogTrack);
        if (catalog) {
            log(`catalog: ${catalog.tracks.map((t) => `${t.name} (${t.packaging})`).join(", ")}`);
        } else {
            log("catalog track closed before a snapshot arrived");
        }

        const eventsTrack = broadcast.subscribe("events", { priority: 0 });

        // Media Timeline: logged on its own, concurrently with the Event Timeline
        // loop below -- a real subscriber consumes both per the spec's
        // Configuration principle (subscribe to both the media timeline and the
        // event timeline), not just the ad-decisioning signaling.
        (async () => {
            const mediaTimeTrack = broadcast.subscribe("mediatime", { priority: 0 });
            for (;;) {
                const entry = await mediaTimeTrack.readJson();
                if (entry === undefined) break;
                const [mediaMs, location, wallMs] = entry;
                log(`MEDIATIME m=${mediaMs}ms location=[${location.join(",")}] wall=${new Date(wallMs).toISOString()}`);
            }
        })().catch((err) => log(`mediatime track error: ${err.message ?? err}`));

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
                case SEGMENTATION_TYPE.PROVIDER_ADVERTISEMENT_START: {
                    const rawUpid = data.segmentation_upid_uri ?? adBroadcast;
                    const upid = substitute(rawUpid, templateVars);
                    if (upid !== rawUpid) log(`  resolved upid template '${rawUpid}' -> '${upid}' using --url's fragment`);
                    log(`  [would] FETCH ad ('${upid}')`);
                    break;
                }
                case SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_END:
                    log(`  [would] RESUBSCRIBE content ('${contentBroadcast}')`);
                    break;
                case SEGMENTATION_TYPE.PROGRAM_BLACKOUT_OVERRIDE:
                    if (data.no_regional_blackout_flag === false) {
                        log(`  [would] ENFORCE blackout -- switch to alternate content ('${data.segmentation_upid_uri}')`);
                    } else {
                        log("  [would] RESTORE normal delivery");
                    }
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
