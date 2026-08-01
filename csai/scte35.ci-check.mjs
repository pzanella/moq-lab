#!/usr/bin/env node
// Byte-for-byte conformance check: encodes the same time_signal +
// segmentation_descriptor message with our in-house encoder (scte35.mjs) and
// with @astronautlabs/scte35 (an independent SCTE-35 implementation), and
// asserts the two outputs are identical. Only covers time_signal -- the only
// splice command this repo's encoder implements (no splice_insert).
//
// astronautlabs models SpliceInfoSection/SpliceDescriptor as a class
// hierarchy with @Variant() discriminators (spliceCommandType, tag). Those
// discriminators are only auto-resolved when *deserializing*; constructing a
// TimeSignalSplice/NewSegmentationDescriptor fresh still requires setting
// them explicitly, or serialize() emits a splice_null (0x00) / an untagged
// descriptor instead of what the subclass implies.
import "reflect-metadata";
import { TimeSignalSplice, NewSegmentationDescriptor, SpliceTime } from "@astronautlabs/scte35";
import { SEGMENTATION_TYPE, buildTimeSignalSection } from "./scte35.mjs";

function buildReference({ segmentationEventId, segmentationTypeId, ptsTime }) {
    const descriptor = new NewSegmentationDescriptor();
    descriptor.tag = 0x02; // SPLICE_DESCRIPTOR_SEGMENTATION variant discriminator
    descriptor.identifier = "CUEI";
    descriptor.remainder = new Uint8Array(0);
    descriptor.eventId = segmentationEventId;
    descriptor.canceled = false;
    descriptor.hasProgram = true;
    descriptor.hasDuration = false;
    descriptor.deliveryNotRestricted = false;
    descriptor.webDeliveryAllowed = false;
    descriptor.noRegionalBlackout = false;
    descriptor.archiveAllowed = false;
    descriptor.deviceRestrictions = 0;
    descriptor.components = [];
    descriptor.upidType = 0;
    descriptor.upid = new Uint8Array(0);
    descriptor.typeId = segmentationTypeId;
    descriptor.segmentNumber = 0;
    descriptor.segmentsExpected = 0;

    const spliceTime = new SpliceTime();
    spliceTime.specified = true;
    spliceTime.reserved1 = 0b111111;
    spliceTime.pts = Number(ptsTime);
    spliceTime.reserved2 = 0;

    const section = new TimeSignalSplice();
    section.tableId = 0xfc;
    section.sectionSyntax = false;
    section.private = false;
    section.reserved = 0b11;
    section.protocolVersion = 0;
    section.encrypted = false;
    section.encryptionAlgorithm = 0;
    section.ptsAdjustment = 0;
    section.cwIndex = 0;
    section.tier = 0xfff;
    section.spliceCommandType = 0x06; // SPLICE_COMMAND_TIME_SIGNAL variant discriminator
    section.spliceTime = spliceTime;
    section.descriptors = [descriptor];

    return Buffer.from(section.serialize());
}

function hexDiff(ours, theirs) {
    const a = ours.toString("hex").match(/../g) ?? [];
    const b = theirs.toString("hex").match(/../g) ?? [];
    const lines = [`  length: ours=${a.length}B theirs=${b.length}B`];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) lines.push(`  byte[${i}]: ours=${a[i] ?? "--"} theirs=${b[i] ?? "--"}`);
    }
    return lines.join("\n");
}

const VECTORS = [
    { segmentationEventId: 0x3e8, segmentationTypeId: SEGMENTATION_TYPE.BREAK_START, ptsTime: 2702250n },
    { segmentationEventId: 0x3e8, segmentationTypeId: SEGMENTATION_TYPE.BREAK_END, ptsTime: 3242250n },
    { segmentationEventId: 1, segmentationTypeId: SEGMENTATION_TYPE.BREAK_START, ptsTime: 2n ** 33n - 1n }, // max 33-bit PTS
    { segmentationEventId: 0, segmentationTypeId: SEGMENTATION_TYPE.BREAK_END, ptsTime: 0n },
];

let fail = 0;
for (const vector of VECTORS) {
    const ours = buildTimeSignalSection(vector);
    const theirs = buildReference(vector);
    const ok = ours.equals(theirs);
    const label = `event=${vector.segmentationEventId} type=0x${vector.segmentationTypeId.toString(16)} pts=${vector.ptsTime}`;
    if (ok) {
        console.log(`PASS  ${label}`);
    } else {
        fail = 1;
        console.log(`FAIL  ${label}`);
        console.log(hexDiff(ours, theirs));
    }
}
process.exit(fail);
