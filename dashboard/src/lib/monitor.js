// The dashboard's own MoQ subscriber. It connects to the relay the same way a
// player would (WebTransport, falling back to WebSocket), subscribes to the
// broadcast's catalog, one video rendition and one audio rendition, and derives
// every number on the page from that live session -- nothing here is simulated.
//
// Where each metric comes from:
//   RTT          WebTransport getStats() smoothedRtt, else the relay's PROBE estimate
//   Packet loss  WebTransport getStats(): packets this browser sent that QUIC declared lost
//   Jitter       RFC 3550 inter-arrival jitter over the video track's frame timestamps
//   Bitrate      WebTransport bytesReceived, else the MoQ payload bytes this page read
//   FPS          video frames received per second (and the nominal rate from timestamps)
//   E2E latency  arrival time minus when lib/ingest-clock.mjs says that media time
//                was due at the source, corrected for host/container clock skew
import * as Moq from "@moq/net";

// hang's catalog track name (the ".json" suffix is hang's convention, not MSF's).
const CATALOG_TRACK = "catalog.json";
const TICK_MS = 1000;
const RECONNECT_MS = 2000;
export const HISTORY_SECONDS = 120;

// A frame can't be newer than what the publisher-side tap has already seen
// (allowing for its write interval). One that is belongs to a publisher run
// that restarted (e.g. each SSAI pass) since the last ingest sample.
const INGEST_MAX_AHEAD_SECS = 2;

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pickVideoRendition(catalog, preferred) {
    const renditions = catalog?.video?.renditions ?? {};
    if (preferred && renditions[preferred]) return preferred;
    // Highest resolution by default: on an --abr-ladder stream that's the rung
    // a player on a fast local link would settle on.
    let best = null;
    for (const [name, r] of Object.entries(renditions)) {
        if (!best || (r.codedHeight ?? 0) > (renditions[best].codedHeight ?? 0)) best = name;
    }
    return best;
}

// Resolves after `ms`, or early once `signal` aborts.
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done);
    });
}

export class StreamMonitor {
    #relayUrl;
    #broadcast;
    #onSnapshot;
    #ingest = null; // latest { mediaSecs, wallMs } from the dashboard server
    #clockOffsetMs = 0; // container clock minus this browser's clock
    #abort = new AbortController();

    #conn = null;
    #state = "connecting";
    #error = null;
    #catalog = null;
    #rendition = null;
    #preferredRendition = null;
    #currentBroadcast = null;
    #video = null; // current video track Subscriber
    #videoGeneration = 0;
    #liveSince = null;

    // Per-tick accumulators.
    #payloadBytes = 0;
    #frames = 0;
    #latencies = [];
    #lastTick = performance.now();
    #prevStats = null;

    // Per-video-subscription state.
    #firstGroup = null;
    #lastGroup = null;
    #prevTransit = null;
    #jitter = 0;
    #recentTimestamps = []; // media seconds, in arrival (decode) order
    #groupStartSecs = null; // the current group's keyframe timestamp

    #metrics = {};
    #history = [];

    constructor({ relayUrl, broadcast, onSnapshot }) {
        this.#relayUrl = relayUrl;
        this.#broadcast = broadcast;
        this.#onSnapshot = onSnapshot;
        this.#run();
        this.#tickLoop();
    }

    setIngest(sample) {
        this.#ingest = sample;
    }

    setClockOffset(ms) {
        this.#clockOffsetMs = ms;
    }

    setRendition(name) {
        this.#preferredRendition = name;
        const broadcast = this.#currentBroadcast;
        if (broadcast && name !== this.#rendition && this.#catalog?.video?.renditions?.[name]) {
            this.#subscribeVideo(broadcast, name);
        }
    }

    close() {
        this.#abort.abort();
        this.#video?.close();
        this.#conn?.close();
    }

    async #run() {
        const signal = this.#abort.signal;
        while (!signal.aborted) {
            try {
                await this.#session(signal);
            } catch (err) {
                if (signal.aborted) return;
                this.#error = err?.message ?? String(err);
                console.warn("[dashboard] session ended:", err);
            }
            this.#teardown();
            if (signal.aborted) return;
            this.#state = "reconnecting";
            this.#emit();
            await sleep(RECONNECT_MS, signal);
        }
    }

    #teardown() {
        this.#video?.close();
        this.#video = null;
        this.#conn?.close();
        this.#conn = null;
        this.#currentBroadcast = null;
        this.#catalog = null;
        this.#rendition = null;
        this.#prevStats = null;
        this.#liveSince = null;
    }

    async #session(signal) {
        this.#emit();
        const conn = await Moq.Connection.connect(new URL(this.#relayUrl), {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        this.#conn = conn;
        this.#error = null;

        // Subscribing before the relay has announced the broadcast gets the stream
        // reset instead of queued (same as sgai/transport.mjs's waitForAnnounced).
        this.#state = "waiting";
        this.#emit();
        const path = Moq.Path.from(this.#broadcast);
        const announced = conn.announced(path);
        for (;;) {
            const entry = await Promise.race([announced.next(), conn.closed.then(() => undefined)]);
            if (!entry) throw new Error("connection closed before the broadcast was announced");
            if (entry.active) break;
        }

        const broadcast = conn.consume(path);
        this.#currentBroadcast = broadcast;
        this.#state = "live";
        this.#liveSince = Date.now();
        this.#emit();

        const catalogTrack = broadcast.subscribe(CATALOG_TRACK, { priority: 0 });
        let audio = null;
        const catalogLoop = (async () => {
            for (;;) {
                const frame = await catalogTrack.readFrame();
                if (!frame) return;
                this.#payloadBytes += frame.payload.byteLength;
                this.#catalog = JSON.parse(new TextDecoder().decode(frame.payload));

                const rendition = pickVideoRendition(this.#catalog, this.#preferredRendition);
                if (rendition && rendition !== this.#rendition) this.#subscribeVideo(broadcast, rendition);

                const audioName = Object.keys(this.#catalog?.audio?.renditions ?? {})[0];
                if (audioName && audio?.name !== audioName) {
                    audio?.close();
                    audio = broadcast.subscribe(audioName, { priority: 1 });
                    this.#drain(audio);
                }
                this.#emit();
            }
        })();

        // The session is over when the connection drops or the publisher goes away
        // (the catalog track closes with its broadcast, e.g. on each SSAI pass restart).
        try {
            await Promise.race([conn.closed, catalogLoop]);
        } finally {
            catalogTrack.close();
            audio?.close();
        }
        throw new Error("broadcast ended");
    }

    #subscribeVideo(broadcast, rendition) {
        this.#video?.close();
        const generation = ++this.#videoGeneration;
        this.#rendition = rendition;
        this.#firstGroup = null;
        this.#lastGroup = null;
        this.#prevTransit = null;
        this.#jitter = 0;
        this.#recentTimestamps = [];
        this.#groupStartSecs = null;

        const track = broadcast.subscribe(rendition, { priority: 2 });
        this.#video = track;
        (async () => {
            for (;;) {
                const frame = await track.readFrameSequence();
                if (!frame || generation !== this.#videoGeneration) return;
                this.#onVideoFrame(frame);
            }
        })().catch((err) => {
            if (generation === this.#videoGeneration) console.warn("[dashboard] video track error:", err);
        });
    }

    // Reads a track only to count its bytes toward the payload bitrate.
    #drain(track) {
        (async () => {
            for (;;) {
                const frame = await track.readFrame();
                if (!frame) return;
                this.#payloadBytes += frame.payload.byteLength;
            }
        })().catch(() => {});
    }

    #onVideoFrame(frame) {
        const arrivalPerf = performance.now();
        const arrivalWall = Date.now();
        this.#payloadBytes += frame.payload.byteLength;
        this.#frames++;

        const mediaSecs = frame.timestamp.value / frame.timestamp.scale;

        this.#recentTimestamps.push(mediaSecs);
        if (this.#recentTimestamps.length > 48) this.#recentTimestamps.shift();
        if (frame.frame === 0) this.#groupStartSecs = mediaSecs;

        // A new subscription starts at the latest group's keyframe, so the relay
        // delivers that group's already-cached frames in one burst. They'd read as
        // seconds of latency and a jitter spike that the stream doesn't actually
        // have, so timing stats start at the next group.
        if (this.#firstGroup === null) this.#firstGroup = frame.group;
        const skippedGroup = this.#lastGroup !== null && frame.group > this.#lastGroup + 1;
        this.#lastGroup = frame.group;
        if (frame.group === this.#firstGroup) return;

        // RFC 3550 section 6.4.1: J += (|D| - J) / 16, with D the change in transit time
        // between consecutive frames. Restart across a skipped group, whose frames never arrived.
        // Frames arrive in decode order but carry presentation timestamps, which B-frames
        // reorder; timing each frame by its decode position instead (keyframe + index *
        // frame duration) keeps that reordering out of D. The keyframe's own
        // presentation delay is the same for every frame, so it cancels.
        const frameSecs = this.#frameDuration();
        if (frameSecs !== null && this.#groupStartSecs !== null) {
            const transit = arrivalPerf - (this.#groupStartSecs + frame.frame * frameSecs) * 1000;
            if (this.#prevTransit !== null && !skippedGroup) {
                const d = Math.abs(transit - this.#prevTransit);
                this.#jitter += (d - this.#jitter) / 16;
            }
            this.#prevTransit = transit;
        }

        const ingest = this.#ingest;
        if (ingest && mediaSecs <= ingest.mediaSecs + INGEST_MAX_AHEAD_SECS) {
            // The sample pins media time to the source's wall-clock pace (see
            // lib/ingest-clock.mjs), so any frame of the same run maps exactly.
            const dueWall = ingest.wallMs + (mediaSecs - ingest.mediaSecs) * 1000;
            this.#latencies.push(arrivalWall + this.#clockOffsetMs - dueWall);
        }
    }

    // Median spacing of recent timestamps once sorted back into presentation order.
    #frameDuration() {
        const sorted = [...this.#recentTimestamps].sort((a, b) => a - b);
        const deltas = [];
        for (let i = 1; i < sorted.length; i++) {
            const d = sorted[i] - sorted[i - 1];
            if (d > 0 && d < 1) deltas.push(d);
        }
        return deltas.length >= 8 ? median(deltas) : null;
    }

    async #tickLoop() {
        const signal = this.#abort.signal;
        while (!signal.aborted) {
            await sleep(TICK_MS, signal);
            if (signal.aborted) return;
            await this.#tick();
        }
    }

    async #tick() {
        const now = performance.now();
        const elapsed = (now - this.#lastTick) / 1000;
        this.#lastTick = now;

        const conn = this.#conn;
        const stats = conn ? await conn.stats() : {};
        const probe = conn?.probe.peek() ?? {};

        let rtt = null;
        let rttSource = null;
        if (stats.rtt !== undefined) {
            rtt = stats.rtt;
            rttSource = "QUIC smoothed RTT";
        } else if (probe.rtt !== undefined) {
            rtt = probe.rtt;
            rttSource = "relay PROBE";
        }

        let bitrate = null;
        let bitrateSource = null;
        let loss = null;
        const prev = this.#prevStats;
        if (stats.bytesReceived !== undefined) {
            if (prev?.bytesReceived !== undefined) {
                bitrate = ((stats.bytesReceived - prev.bytesReceived) * 8) / elapsed / 1e6;
                bitrateSource = "QUIC bytes received";
            }
            if (prev?.packetsSent !== undefined && stats.packetsSent !== undefined && stats.packetsLost !== undefined) {
                const sent = stats.packetsSent - prev.packetsSent;
                // packetsLost can go down when a loss turns out to be spurious.
                const lost = Math.max(0, stats.packetsLost - prev.packetsLost);
                loss = sent > 0 ? (lost / sent) * 100 : 0;
            }
            this.#prevStats = stats;
        } else if (this.#state === "live") {
            bitrate = (this.#payloadBytes * 8) / elapsed / 1e6;
            bitrateSource = "MoQ payload bytes";
        }
        this.#payloadBytes = 0;

        const fps = this.#state === "live" ? this.#frames / elapsed : null;
        this.#frames = 0;

        const latency = median(this.#latencies);
        this.#latencies = [];

        const jitter = this.#prevTransit !== null ? this.#jitter : null;

        this.#history.push({ t: Date.now(), rtt, bitrate, loss, jitter, fps, latency });
        if (this.#history.length > HISTORY_SECONDS) this.#history.shift();

        this.#metrics = { rtt, rttSource, bitrate, bitrateSource, loss, jitter, fps, latency };
        this.#emit();
    }

    #emit() {
        const catalog = this.#catalog;
        const video = this.#rendition ? catalog?.video?.renditions?.[this.#rendition] : null;
        const audioEntry = Object.entries(catalog?.audio?.renditions ?? {})[0];
        const nominalDelta = this.#frameDuration();

        this.#onSnapshot({
            connection: {
                state: this.#state,
                error: this.#error,
                transport: this.#conn?.transport ?? null,
                version: this.#conn?.version ?? null,
                liveSince: this.#liveSince,
            },
            ...this.#metrics,
            video: video
                ? {
                      rendition: this.#rendition,
                      codec: video.codec,
                      width: video.codedWidth,
                      height: video.codedHeight,
                      bitrate: video.bitrate ?? null,
                      nominalFps: nominalDelta ? 1 / nominalDelta : null,
                  }
                : null,
            audio: audioEntry
                ? {
                      rendition: audioEntry[0],
                      codec: audioEntry[1].codec,
                      sampleRate: audioEntry[1].sampleRate,
                      channels: audioEntry[1].numberOfChannels,
                  }
                : null,
            renditions: Object.entries(catalog?.video?.renditions ?? {})
                .map(([name, r]) => ({ name, width: r.codedWidth, height: r.codedHeight, bitrate: r.bitrate ?? null }))
                .sort((a, b) => (b.height ?? 0) - (a.height ?? 0)),
            history: [...this.#history],
        });
    }
}
