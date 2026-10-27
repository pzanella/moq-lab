// The browser side of SGAI: reads the Event Timeline that
// sgai/ad-decisioning-publisher.mjs publishes and hands each record to the player.
// It does what sgai/debug-subscriber.mjs only logs ("[would] FETCH ad", ...).
import * as Moq from "@moq/net";

const RECONNECT_MS = 2000;

// segmentation_type_id values, as sgai/event-timeline.mjs writes them.
export const SEGMENTATION_TYPE = {
    PLACEMENT_OPPORTUNITY_START: "0x34",
    PLACEMENT_OPPORTUNITY_END: "0x35",
    AD_START: "0x30",
    AD_END: "0x31",
    PROGRAM_BLACKOUT_OVERRIDE: "0x18",
};

export const SEGMENTATION_TYPE_NAMES = {
    "0x34": "Placement Opportunity Start",
    "0x35": "Placement Opportunity End",
    "0x30": "Ad Start",
    "0x31": "Ad End",
    "0x18": "Program Blackout Override",
};

// The broadcast an upid points at: `ns=` of a moqt:// URL (lib/msf-uri.mjs's
// buildUri()), e.g. moqt://localhost?ns=bbb-ad-0.hang. Undefined for anything else.
export function upidBroadcast(upid) {
    if (!upid) return undefined;
    try {
        return new URL(upid).searchParams.get("ns") ?? undefined;
    } catch {
        return undefined;
    }
}

export class EventTimeline {
    #relayUrl;
    #broadcast;
    #onRecord;
    #onState;
    #abort = new AbortController();

    constructor({ relayUrl, broadcast, onRecord, onState }) {
        this.#relayUrl = relayUrl;
        this.#broadcast = broadcast;
        this.#onRecord = onRecord;
        this.#onState = onState;
        this.#run();
    }

    close() {
        this.#abort.abort();
    }

    async #run() {
        const signal = this.#abort.signal;
        while (!signal.aborted) {
            const origin = new Moq.Origin.Producer();
            let conn;
            try {
                this.#onState("connecting");
                conn = await Moq.Connection.connect({ url: new URL(this.#relayUrl), consume: origin, signal });
                await this.#read(origin, conn, signal);
            } catch (err) {
                if (!signal.aborted) console.warn("[dashboard] event timeline:", err);
            } finally {
                conn?.close();
                origin.close();
            }
            if (signal.aborted) return;
            this.#onState("reconnecting");
            await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
        }
    }

    async #read(origin, conn, signal) {
        const request = origin.request(Moq.Path.from(this.#broadcast), { announced: true });
        const stop = Promise.race([conn.closed, new Promise((resolve) => signal.addEventListener("abort", resolve))]).then(
            () => null,
        );
        try {
            let broadcast = request.active.peek();
            while (!broadcast) {
                this.#onState("waiting");
                if ((await Promise.race([request.active.changed(), stop])) === null) return;
                broadcast = request.active.peek();
            }
            this.#onState("live");

            // One group per ad-break cycle, one record per frame. Read each group to its
            // end, so no record of a cycle is skipped when the next group arrives. A new
            // subscription starts at the current cycle's group, so a page opened in the
            // middle of a break still gets its Ad Start.
            const track = broadcast.track("events").subscribe({ priority: 0 });
            try {
                for (;;) {
                    const group = await Promise.race([track.recvGroup(), stop]);
                    if (!group) return;
                    for (;;) {
                        const record = await Promise.race([group.readJson(), stop]);
                        if (!record) break;
                        this.#onRecord(record);
                    }
                }
            } finally {
                track.close();
            }
        } finally {
            request.close();
        }
    }
}
