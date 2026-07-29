// Builds real MSF Media Timeline entries -- [mediaTimeMs, [groupId, objectId],
// wallClockMs] -- for the content video track, per draft-ietf-moq-msf's
// explicit-entry Media Timeline format (see README section 7). groupId/
// objectId come straight off the wire (Group/frame sequence numbers); nothing
// here is guessed or derived from encode settings.
import { boxHeader, scanBoxes, parseMoov, parseMoofDecodeTime } from "../lib/fmp4.mjs";

// moq-cli only ever delivers a video rendition's init segment (ftyp+moov) as
// the catalog's own `container.init` (base64) -- confirmed empirically that a
// live subscription to the track never receives a moov, only moof+mdat
// fragments. Fetch the catalog once at startup to learn the video track's ID
// and timescale, and which rendition name to subscribe to.
export async function resolveVideoTiming(relayUrl, contentBroadcast, { timeoutMs = 5000 } = {}) {
    // A relay's /fetch endpoint for a broadcast that never gets announced hangs
    // rather than 404ing (confirmed empirically) -- bound every attempt so a
    // caller retrying this in a loop can still notice a shutdown signal instead
    // of blocking on one unresolved request forever.
    const res = await fetch(`${relayUrl}/fetch/${contentBroadcast}/catalog.json`, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
    const catalog = await res.json();
    const renditions = catalog.video?.renditions;
    const trackName = renditions && Object.keys(renditions)[0];
    const init = trackName && renditions[trackName]?.container?.init;
    if (!init) throw new Error(`no video rendition with an init segment in ${contentBroadcast}'s catalog`);
    const initBuf = Buffer.from(init, "base64");

    let videoTrackId = null;
    let timescales = new Map();
    scanBoxes(initBuf, {
        moov: (body) => {
            const parsed = parseMoov(body);
            videoTrackId = parsed.videoTrackId;
            timescales = parsed.timescales;
        },
    });
    if (videoTrackId === null) throw new Error(`no video track in ${contentBroadcast}/${trackName}'s init segment`);
    return { trackName, videoTrackId, timescale: timescales.get(videoTrackId) ?? 90000 };
}

// A live object's payload is one CMAF fragment (moof+mdat, per run-stream.sh's
// separate_moof+frag_every_frame flags): pulls out just the moof box's own
// content, since parseMoofDecodeTime() expects that, not the sibling mdat
// alongside it (mirrors how ssai/impression-tracker.mjs's streaming parser
// only ever hands moof its inner body).
function extractMoofBody(buf) {
    let off = 0;
    while (off + 8 <= buf.length) {
        const hdr = boxHeader(buf, off);
        if (!hdr) break;
        if (buf.subarray(off + 4, off + 8).toString("ascii") === "moof") {
            return buf.subarray(off + hdr.headerSize, off + hdr.size);
        }
        off += hdr.size;
    }
    return null;
}

// Resolves one live video object into a Media Timeline entry, or null if this
// fragment carries no tfdt for the video track.
export function mediaTimelineEntry(object, videoTrackId, timescale) {
    const buf = Buffer.from(object.payload);
    const moofBody = extractMoofBody(buf);
    const decodeTime = moofBody ? parseMoofDecodeTime(moofBody, videoTrackId) : null;
    if (decodeTime === null) return null;
    const mediaMs = Math.round((decodeTime / timescale) * 1000);
    return [mediaMs, [object.group, object.frame], Date.now()];
}
