// SCTE-35 splice_info_section encoder — builds real, spec-compliant binary
// cues (time_signal + segmentation_descriptor) for the CSAI sandbox.
// Reference: ANSI/SCTE 35, sections 9.2 (splice_info_section), 9.3.4
// (time_signal), 10.3.3 (segmentation_descriptor). CRC-32 is the same
// MPEG-2 variant used by PSI tables (poly 0x04C11DB7, no reflect, init/xorout 0).

export const SEGMENTATION_TYPE = {
    BREAK_START: 0x22,
    BREAK_END: 0x23,
};

const CUEI_IDENTIFIER = 0x43554549; // 'CUEI'
const SPLICE_COMMAND_TIME_SIGNAL = 0x06;
const SPLICE_DESCRIPTOR_SEGMENTATION = 0x02;

// Appends bits MSB-first; packed into bytes on toBuffer(). Bit-exact section
// layouts are easy to get wrong by hand-shifting, so track individual bits instead.
class BitWriter {
    constructor() {
        this._bits = [];
    }

    writeBits(value, count) {
        for (let i = count - 1; i >= 0; i--) {
            this._bits.push((value >>> i) & 1);
        }
        return this;
    }

    // For values wider than 32 bits (pts_time is 33 bits): pass a BigInt.
    writeBitsBig(value, count) {
        for (let i = BigInt(count - 1); i >= 0n; i--) {
            this._bits.push(Number((value >> i) & 1n));
        }
        return this;
    }

    toBuffer() {
        if (this._bits.length % 8 !== 0) {
            throw new Error(`BitWriter: ${this._bits.length} bits is not byte-aligned`);
        }
        const out = Buffer.alloc(this._bits.length / 8);
        for (let byteIdx = 0; byteIdx < out.length; byteIdx++) {
            let byte = 0;
            for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
                byte = (byte << 1) | this._bits[byteIdx * 8 + bitIdx];
            }
            out[byteIdx] = byte;
        }
        return out;
    }
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n << 24;
        for (let k = 0; k < 8; k++) {
            c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

// CRC-32/MPEG-2: poly 0x04C11DB7, init 0xFFFFFFFF, no input/output reflection, xorout 0.
export function crc32Mpeg2(buf) {
    let crc = 0xffffffff;
    for (const byte of buf) {
        crc = ((crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    }
    return crc >>> 0;
}

function segmentationDescriptor({ segmentationEventId, segmentationTypeId }) {
    const w = new BitWriter();
    w.writeBits(CUEI_IDENTIFIER, 32);
    w.writeBits(segmentationEventId, 32);
    w.writeBits(0, 1); // segmentation_event_cancel_indicator
    w.writeBits(0b1111111, 7); // reserved

    w.writeBits(1, 1); // program_segmentation_flag: whole program, no component list
    w.writeBits(0, 1); // segmentation_duration_flag: not signaled
    w.writeBits(0, 1); // delivery_not_restricted_flag: restrictions below DO apply
    w.writeBits(0, 1); // web_delivery_allowed_flag
    w.writeBits(0, 1); // no_regional_blackout_flag
    w.writeBits(0, 1); // archive_allowed_flag
    w.writeBits(0b00, 2); // device_restrictions: 00 = "Restrict Group 0"

    w.writeBits(0x00, 8); // segmentation_upid_type: not used
    w.writeBits(0, 8); // segmentation_upid_length
    w.writeBits(segmentationTypeId, 8);
    w.writeBits(0, 8); // segment_num
    w.writeBits(0, 8); // segments_expected

    const body = w.toBuffer(); // identifier..segments_expected, excluding tag+length
    const header = Buffer.from([SPLICE_DESCRIPTOR_SEGMENTATION, body.length]);
    return Buffer.concat([header, body]);
}

/**
 * Builds a complete splice_info_section (time_signal + one segmentation_descriptor),
 * CRC included, ready to be wrapped in a PES packet.
 *
 * @param {object} opts
 * @param {number} opts.segmentationEventId - 32-bit event id (unique per Break Start/End pair)
 * @param {number} opts.segmentationTypeId - SEGMENTATION_TYPE.BREAK_START or BREAK_END
 * @param {bigint} opts.ptsTime - 33-bit PTS (90kHz ticks) the cue applies at
 * @returns {Buffer}
 */
export function buildTimeSignalSection({ segmentationEventId, segmentationTypeId, ptsTime }) {
    const descriptor = segmentationDescriptor({ segmentationEventId, segmentationTypeId });

    const spliceCommand = new BitWriter();
    spliceCommand.writeBits(1, 1); // time_specified_flag
    spliceCommand.writeBits(0b111111, 6); // reserved
    spliceCommand.writeBitsBig(ptsTime, 33);
    const spliceCommandBuf = spliceCommand.toBuffer(); // 5 bytes

    // Everything from protocol_version through the descriptor loop — i.e. the part
    // of section_length that isn't known until the descriptor/command are sized.
    const body = new BitWriter();
    body.writeBits(0, 8); // protocol_version
    body.writeBits(0, 1); // encrypted_packet
    body.writeBits(0, 6); // encryption_algorithm
    body.writeBitsBig(0n, 33); // pts_adjustment
    body.writeBits(0, 8); // cw_index
    body.writeBits(0xfff, 12); // tier (not used)
    body.writeBits(spliceCommandBuf.length, 12); // splice_command_length
    body.writeBits(SPLICE_COMMAND_TIME_SIGNAL, 8); // splice_command_type
    const bodyHead = body.toBuffer();

    const descriptorLoop = new BitWriter().writeBits(descriptor.length, 16).toBuffer();

    // section_length covers everything after itself, through the CRC (4 bytes).
    const afterLength = Buffer.concat([bodyHead, spliceCommandBuf, descriptorLoop, descriptor, Buffer.alloc(4)]);
    const sectionLength = afterLength.length;

    const header = new BitWriter();
    header.writeBits(0xfc, 8); // table_id
    header.writeBits(0, 1); // section_syntax_indicator
    header.writeBits(0, 1); // private_indicator
    header.writeBits(0b11, 2); // sap_type: not specified
    header.writeBits(sectionLength, 12);

    const withoutCrc = Buffer.concat([
        header.toBuffer(),
        afterLength.subarray(0, afterLength.length - 4),
    ]);
    const crc = crc32Mpeg2(withoutCrc);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);

    return Buffer.concat([withoutCrc, crcBuf]);
}
