#!/usr/bin/env node
// CSAI SCTE-35 injector — transparent MPEG-TS proxy.
// Usage: ffmpeg ... -f mpegts - | node ts-injector.mjs <adBreakEvery> <adBreakLength> | moq ... import ts
//
// Passes every TS packet from ffmpeg to stdout unchanged, except the PMT,
// which is rewritten (once per repetition) to add a private "SCTE-35" stream
// (stream_type 0x06, CUEI registration descriptor) on a synthesized PID. It
// also injects real, CRC-valid SCTE-35 Break Start / Break End cues
// (splice_info_section, PES stream_id 0xFC per SCTE-35 sec. 9.7) on that PID —
// see scte35.mjs for the section encoder. Cue timing is driven by the video
// elementary stream's own PES decode timestamps (DTS, falling back to PTS for
// frames without B-reordering), not the wall clock -- accurate even if ffmpeg
// falls behind real-time under load (e.g. a heavy --abr-ladder encode).
//
// This is the MPEG-TS analog of ../ssai/impression-tracker.mjs (which does the
// same transparent-proxy trick for fMP4 boxes, reading tfdt instead of PES
// timestamps); the two are independent and never run together — SSAI uses
// fmp4/moq import fmp4, CSAI uses ts/moq import ts.
import { buildTimeSignalSection, crc32Mpeg2, SEGMENTATION_TYPE } from "./scte35.mjs";
import { createLogger } from "../lib/log.mjs";

const log = createLogger("CSAI");

const TS_PACKET_SIZE = 188;
const PAT_PID = 0;
const SCTE35_STREAM_TYPE = 0x06;
const SCTE35_PES_STREAM_ID = 0xfc; // reserved for splice_info_section per SCTE-35 sec. 9.7
const CUEI_REGISTRATION_DESCRIPTOR = Buffer.from([0x05, 0x04, 0x43, 0x55, 0x45, 0x49]); // tag, len, 'CUEI'

const AD_BREAK_EVERY = Number(process.argv[2] ?? 30);
const AD_BREAK_LENGTH = Number(process.argv[3] ?? 6);
if (!Number.isFinite(AD_BREAK_EVERY) || AD_BREAK_EVERY <= 0) {
    process.stderr.write(`[CSAI] error: invalid adBreakEvery: ${process.argv[2]}\n`);
    process.exit(1);
}
if (!Number.isFinite(AD_BREAK_LENGTH) || AD_BREAK_LENGTH <= 0) {
    process.stderr.write(`[CSAI] error: invalid adBreakLength: ${process.argv[3]}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Bit-field helpers for the small PAT/PMT parse+rebuild this needs.
// ---------------------------------------------------------------------------

// PSI packet payloads are padded with 0xFF stuffing to fill the 184-byte TS
// payload; trim to the section's own declared length before parsing it.
function trimToSectionLength(raw) {
    const sectionLength = ((raw[1] & 0x0f) << 8) | raw[2];
    return raw.subarray(0, 3 + sectionLength);
}

function parsePat(section) {
    // section = table_id..last_section_number..(program entries)..CRC_32
    const programs = [];
    let off = 8; // past table_id(1) + length fields(2) + transport_stream_id(2) + reserved/version(1) + section_number(1) + last_section_number(1)
    while (off + 4 <= section.length - 4) {
        const programNumber = section.readUInt16BE(off);
        const pid = section.readUInt16BE(off + 2) & 0x1fff;
        programs.push({ programNumber, pid });
        off += 4;
    }
    return programs;
}

function parsePmt(section) {
    const programNumber = section.readUInt16BE(3);
    const pcrPid = section.readUInt16BE(8) & 0x1fff;
    const programInfoLength = section.readUInt16BE(10) & 0x0fff;
    const programDescriptors = section.subarray(12, 12 + programInfoLength);

    const streams = [];
    let off = 12 + programInfoLength;
    const end = section.length - 4; // exclude CRC_32
    while (off + 5 <= end) {
        const streamType = section[off];
        const pid = section.readUInt16BE(off + 1) & 0x1fff;
        const esInfoLength = section.readUInt16BE(off + 3) & 0x0fff;
        const descriptors = section.subarray(off + 5, off + 5 + esInfoLength);
        streams.push({ streamType, pid, descriptors });
        off += 5 + esInfoLength;
    }
    return { programNumber, pcrPid, programDescriptors, streams };
}

// Rebuilds a PMT section with one extra stream entry appended, CRC recomputed.
function buildPmt({ programNumber, pcrPid, programDescriptors, streams }) {
    const streamsBuf = Buffer.concat(
        streams.map((s) => {
            const head = Buffer.alloc(5);
            head[0] = s.streamType;
            head.writeUInt16BE(0xe000 | (s.pid & 0x1fff), 1);
            head.writeUInt16BE(0xf000 | (s.descriptors.length & 0x0fff), 3);
            return Buffer.concat([head, s.descriptors]);
        }),
    );

    const body = Buffer.alloc(4 + programDescriptors.length);
    body.writeUInt16BE(0xe000 | (pcrPid & 0x1fff), 0);
    body.writeUInt16BE(0xf000 | (programDescriptors.length & 0x0fff), 2);
    programDescriptors.copy(body, 4);

    const sectionTail = Buffer.concat([body, streamsBuf]);
    const sectionLength = 5 + sectionTail.length + 4; // programNumber..reserved/version..section_number..last_section_number + tail + CRC

    const head = Buffer.alloc(8);
    head[0] = 0x02; // table_id
    head.writeUInt16BE(0xb000 | (sectionLength & 0x0fff), 1); // section_syntax_indicator=1, reserved='11'
    head.writeUInt16BE(programNumber, 3);
    head[5] = 0xc1; // reserved '11' + version_number 00000 + current_next_indicator 1
    head[6] = 0x00; // section_number
    head[7] = 0x00; // last_section_number

    const withoutCrc = Buffer.concat([head, sectionTail]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32Mpeg2(withoutCrc), 0);
    return Buffer.concat([withoutCrc, crc]);
}

// ---------------------------------------------------------------------------
// TS packet helpers
// ---------------------------------------------------------------------------

function tsHeader({ pid, pusi, continuityCounter, hasAdaptation, hasPayload }) {
    const header = Buffer.alloc(4);
    header[0] = 0x47;
    header[1] = ((pusi ? 1 : 0) << 6) | ((pid >> 8) & 0x1f);
    header[2] = pid & 0xff;
    // adaptation_field_control: '01' payload only, '10' adaptation only, '11' both
    header[3] = (continuityCounter & 0x0f) | (hasAdaptation ? 0x20 : 0) | (hasPayload ? 0x10 : 0);
    return header;
}

// Packs a payload (<=184 bytes) into one TS packet, stuffing with an adaptation
// field to fill exactly 188 bytes. Both our PAT/PMT sections and SCTE-35 PES
// cues are always small enough for a single packet (verified at runtime).
function packetizeSingle({ pid, continuityCounter, payload, kind }) {
    if (payload.length > 184) {
        throw new Error(`${kind} too large for a single TS packet: ${payload.length} bytes`);
    }
    const stuffLen = 184 - payload.length;
    const header = tsHeader({ pid, pusi: true, continuityCounter, hasAdaptation: stuffLen > 0, hasPayload: true });
    if (stuffLen === 0) return Buffer.concat([header, payload]);

    // adaptation_field_length(1) + flags(1) + stuffing bytes(0xFF)
    const adaptationLen = stuffLen - 1;
    const adaptation = Buffer.alloc(stuffLen);
    adaptation[0] = adaptationLen;
    if (adaptationLen > 0) {
        adaptation[1] = 0x00;
        adaptation.fill(0xff, 2);
    }
    return Buffer.concat([header, adaptation, payload]);
}

// PSI sections (PAT/PMT, already including their CRC) are prefixed with a
// pointer_field when carried at the start of a TS packet payload.
function packetizeSection({ pid, continuityCounter, section }) {
    const payload = Buffer.concat([Buffer.from([0x00]), section]);
    return packetizeSingle({ pid, continuityCounter, payload, kind: "section" });
}

function packetizePes({ pid, continuityCounter, pes }) {
    return packetizeSingle({ pid, continuityCounter, payload: pes, kind: "PES" });
}

// Offset of the payload within a TS packet, accounting for an optional
// adaptation field (video packets carrying a PCR use one). Returns -1 for
// adaptation-only packets (control byte 0x02), which carry no payload.
function payloadStart(packet) {
    const adaptationFieldControl = (packet[3] >> 4) & 0x03;
    if (adaptationFieldControl === 0x01) return 4;
    if (adaptationFieldControl === 0x03) return 5 + packet[4];
    return -1;
}

// Reads a 33-bit PES timestamp (PTS or DTS) at `off`, per ISO/IEC 13818-1 sec. 2.4.3.6.
function readTimestamp33(buf, off) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const b2 = buf[off + 2];
    const b3 = buf[off + 3];
    const b4 = buf[off + 4];
    const hi = BigInt((b0 >> 1) & 0x07);
    const mid = BigInt(((b1 << 8) | b2) >> 1);
    const lo = BigInt(((b3 << 8) | b4) >> 1);
    return (hi << 30n) | (mid << 15n) | lo;
}

// Extracts the video decode timestamp from a PES packet header, in seconds.
// Prefers DTS (decode order, always monotonic -- what ssai/impression-tracker.mjs
// gets for free from fMP4's tfdt) over PTS (presentation order, which B-frames can
// make non-monotonic); DTS is only present when it differs from PTS, so falling
// back to PTS for PTS-only headers is exact, not an approximation.
function extractVideoDecodeTime(payload) {
    if (payload.length < 14) return null;
    if (payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) return null; // not a PES start
    const ptsDtsFlags = (payload[7] >> 6) & 0x03;
    if (ptsDtsFlags === 0) return null; // no timestamp in this header
    const hasDts = ptsDtsFlags === 0x03 && payload.length >= 19;
    const ts90k = readTimestamp33(payload, hasDts ? 14 : 9);
    return Number(ts90k) / 90000;
}

function buildScte35Pes(section) {
    const optionalHeader = Buffer.from([0x80, 0x00, 0x00]); // '10' + flags=0, PTS_DTS_flags=00, header_data_length=0
    const pesPacketLength = optionalHeader.length + section.length;
    const head = Buffer.alloc(6);
    head[0] = 0x00;
    head[1] = 0x00;
    head[2] = 0x01;
    head[3] = SCTE35_PES_STREAM_ID;
    head.writeUInt16BE(pesPacketLength, 4);
    return Buffer.concat([head, optionalHeader, section]);
}

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

let pmtPid = null;
let pmtOriginal = null; // { programNumber, pcrPid, programDescriptors, streams }
let scte35Pid = null;
let scte35Cc = 0;
let videoPid = null;
const patSeenPids = new Set([PAT_PID]);

// stream_type 0x1B is H.264/AVC per ISO/IEC 13818-1 table 2-34 -- what this
// sandbox's ffmpeg pipeline always produces (single rendition or ABR ladder).
const H264_STREAM_TYPE = 0x1b;

function pickScte35Pid(usedPids) {
    for (let pid = 0x1f0; pid < 0x1fff; pid++) {
        if (!usedPids.has(pid)) return pid;
    }
    throw new Error("no free PID available for the SCTE-35 track");
}

function augmentedPmtBytes(continuityCounter) {
    const streams = [
        ...pmtOriginal.streams,
        { streamType: SCTE35_STREAM_TYPE, pid: scte35Pid, descriptors: CUEI_REGISTRATION_DESCRIPTOR },
    ];
    const section = buildPmt({ ...pmtOriginal, streams });
    return packetizeSection({ pid: pmtPid, continuityCounter, section });
}

// ---------------------------------------------------------------------------
// Break Start / Break End scheduling — driven by the video elementary stream's
// own decode timestamps (see extractVideoDecodeTime above), the same approach
// ssai/impression-tracker.mjs uses via tfdt. Accurate regardless of whether
// ffmpeg is keeping up with real time.
// ---------------------------------------------------------------------------

const CYCLE_SECS = AD_BREAK_EVERY + AD_BREAK_LENGTH;
let pendingCue = null; // Buffer[] of TS packets waiting to be spliced in after the current packet

let lastPts = -1;
let ptsBase = 0;
let lastCycleIndex = -1;
const startFired = new Set();

function onVideoDecodeTime(pts) {
    // Detect a PTS reset (e.g. ffmpeg's -stream_loop wrapping back to the start).
    if (lastPts >= 0 && pts < lastPts - CYCLE_SECS) {
        ptsBase += Math.ceil(lastPts / CYCLE_SECS) * CYCLE_SECS;
        log(`PTS reset — base now ${ptsBase.toFixed(3)}s`);
    }
    lastPts = pts;

    const streamSecs = pts + ptsBase;
    const cycleIndex = Math.floor(streamSecs / CYCLE_SECS);
    const cyclePos = streamSecs % CYCLE_SECS;

    // Break End closes the *previous* cycle's break -- it lands exactly on this
    // boundary because CYCLE_SECS is defined as AD_BREAK_EVERY + AD_BREAK_LENGTH.
    // Guarded on startFired so we never emit an End without a matching Start
    // (e.g. if playback picks up mid-cycle).
    if (lastCycleIndex >= 0 && cycleIndex > lastCycleIndex && startFired.has(lastCycleIndex)) {
        fireCue(SEGMENTATION_TYPE.BREAK_END, 1000 + lastCycleIndex, "Break End", streamSecs);
    }
    lastCycleIndex = cycleIndex;

    if (cyclePos >= AD_BREAK_EVERY && !startFired.has(cycleIndex)) {
        startFired.add(cycleIndex);
        fireCue(SEGMENTATION_TYPE.BREAK_START, 1000 + cycleIndex, "Break Start", streamSecs);
    }
}

function fireCue(segmentationTypeId, segmentationEventId, label, streamSecs) {
    if (scte35Pid === null) return; // PMT not seen yet; drop rather than block startup
    const ptsTime = BigInt(Math.round(streamSecs * 90000)) % 2n ** 33n;
    const section = buildTimeSignalSection({ segmentationEventId, segmentationTypeId, ptsTime });
    const pes = buildScte35Pes(section);
    const packets = [];
    // Our sections are always small enough for one PES/TS packet (see packetizePes);
    // this loop is defensive in case a future descriptor grows past that.
    let offset = 0;
    while (offset < pes.length) {
        const chunk = pes.subarray(offset, offset + 184);
        packets.push(packetizePes({ pid: scte35Pid, continuityCounter: scte35Cc, pes: chunk }));
        scte35Cc = (scte35Cc + 1) & 0x0f;
        offset += 184;
    }
    pendingCue = Buffer.concat(packets);
    log(`${label} (event_id=0x${segmentationEventId.toString(16)}, pts=${ptsTime}, pid=${scte35Pid})`);
}

// ---------------------------------------------------------------------------
// Pipeline: stdin (TS packets) -> stdout (passthrough, PMT rewritten, cues spliced)
// ---------------------------------------------------------------------------

let leftover = Buffer.alloc(0);

function handlePacket(packet) {
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const pusi = (packet[1] & 0x40) !== 0;

    if (pid === PAT_PID && pusi && pmtPid === null) {
        const pointerField = packet[4];
        const section = trimToSectionLength(packet.subarray(5 + pointerField));
        const programs = parsePat(section);
        for (const p of programs) patSeenPids.add(p.pid);
        if (programs.length > 0) {
            pmtPid = programs[0].pid;
            log(`found PMT pid=${pmtPid} (program ${programs[0].programNumber})`);
        }
    }

    if (pmtPid !== null && pid === pmtPid && pusi) {
        const pointerField = packet[4];
        const section = trimToSectionLength(packet.subarray(5 + pointerField));
        const continuityCounter = packet[3] & 0x0f;

        if (pmtOriginal === null) {
            pmtOriginal = parsePmt(section);
            const usedPids = new Set([...patSeenPids, pmtPid, pmtOriginal.pcrPid, ...pmtOriginal.streams.map((s) => s.pid)]);
            scte35Pid = pickScte35Pid(usedPids);
            // In --abr-ladder mode there are 5 video streams (one per rendition, all
            // frame-aligned since they're split from the same source); any one of them
            // gives an identical timeline, so just take the first.
            videoPid = pmtOriginal.streams.find((s) => s.streamType === H264_STREAM_TYPE)?.pid ?? null;
            log(`PMT parsed: ${pmtOriginal.streams.length} existing stream(s), scte35Pid=${scte35Pid}, videoPid=${videoPid}`);
        }

        process.stdout.write(augmentedPmtBytes(continuityCounter));
        return;
    }

    if (pid === videoPid && pusi) {
        const off = payloadStart(packet);
        if (off >= 0 && off < packet.length) {
            const dts = extractVideoDecodeTime(packet.subarray(off));
            if (dts !== null) onVideoDecodeTime(dts);
        }
    }

    process.stdout.write(packet);
}

process.stdin.on("data", (chunk) => {
    leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;

    let offset = 0;
    while (offset + TS_PACKET_SIZE <= leftover.length) {
        if (leftover[offset] !== 0x47) {
            // Lost sync (shouldn't happen with a well-formed ffmpeg mpegts output);
            // resync by scanning for the next sync byte rather than corrupting the stream.
            const nextSync = leftover.indexOf(0x47, offset + 1);
            if (nextSync === -1) {
                offset = leftover.length;
                break;
            }
            log(`resync: dropped ${nextSync - offset} bytes`);
            offset = nextSync;
            continue;
        }
        handlePacket(leftover.subarray(offset, offset + TS_PACKET_SIZE));
        offset += TS_PACKET_SIZE;

        if (pendingCue) {
            process.stdout.write(pendingCue);
            pendingCue = null;
        }
    }
    leftover = leftover.subarray(offset);
});

process.stdin.on("end", () => {
    process.stdout.end();
    log("stream ended");
});

process.stdin.on("error", (err) => {
    process.stderr.write(`[CSAI] stdin error: ${err.message}\n`);
    process.exit(1);
});

log(`adBreakEvery=${AD_BREAK_EVERY} adBreakLength=${AD_BREAK_LENGTH}`);
