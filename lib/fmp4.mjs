// Minimal fMP4 (ISO BMFF) box helpers shared by everything in this repo that
// needs a track's decode time: ssai/impression-tracker.mjs (streaming, via its
// own buffering) and sgai/media-timeline.mjs (discrete per-object buffers).
// Deliberately narrow -- only the boxes needed to map a track's tfdt back to
// its timescale (mdhd) and to tell video from audio (hdlr).

// When rawSize === 1, the spec uses a 64-bit "largesize" at bytes 8-15.
export function boxHeader(buf, off) {
    const rawSize = buf.readUInt32BE(off);
    if (rawSize === 1) {
        if (buf.length < off + 16) return null; // incomplete, wait
        const hi = buf.readUInt32BE(off + 8);
        const lo = buf.readUInt32BE(off + 12);
        return { size: hi * 0x100000000 + lo, headerSize: 16 };
    }
    return { size: rawSize, headerSize: 8 };
}

export function scanBoxes(buf, handlers) {
    let off = 0;
    while (off + 8 <= buf.length) {
        const hdr = boxHeader(buf, off);
        if (!hdr) break;
        const { size, headerSize } = hdr;
        if (size < headerSize || off + size > buf.length) break;
        const type = buf.subarray(off + 4, off + 8).toString("ascii");
        handlers[type]?.(buf.subarray(off + headerSize, off + size));
        off += size;
    }
}

// Reads every trak's trackId/timescale out of a moov body, plus the first
// video trackId found (by hdlr's handler_type == 'vide').
export function parseMoov(body) {
    const timescales = new Map(); // trackId → timescale
    let videoTrackId = null;
    scanBoxes(body, {
        trak: (b) => {
            let trackId = null,
                timescale = null,
                isVideo = false;
            scanBoxes(b, {
                tkhd: (tb) => {
                    // track_ID is at offset 12 (version 0) or 20 (version 1)
                    const off = tb[0] === 1 ? 20 : 12;
                    if (tb.length >= off + 4) trackId = tb.readUInt32BE(off);
                },
                mdia: (mb) => {
                    scanBoxes(mb, {
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
                timescales.set(trackId, timescale);
                if (isVideo && videoTrackId === null) videoTrackId = trackId;
            }
        },
    });
    return { timescales, videoTrackId };
}

// Reads the tfdt decode time for `wantTrackId` out of a moof body, or null if
// that track has no traf (or no tfdt) in this fragment.
export function parseMoofDecodeTime(body, wantTrackId) {
    let result = null;
    scanBoxes(body, {
        traf: (b) => {
            let trackId = null,
                decodeTime = null;
            scanBoxes(b, {
                tfhd: (tb) => {
                    if (tb.length >= 8) trackId = tb.readUInt32BE(4);
                },
                tfdt: (tb) => {
                    if (tb.length < 8) return;
                    // base_media_decode_time: 4 bytes (version 0) or 8 bytes (version 1)
                    decodeTime = tb[0] === 1 ? Number(tb.readBigUInt64BE(4)) : tb.readUInt32BE(4);
                },
            });
            if (trackId === wantTrackId && decodeTime !== null) result = decodeTime;
        },
    });
    return result;
}
