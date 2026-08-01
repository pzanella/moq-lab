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
import { SEGMENTATION_TYPE, buildTimeSignalSection, buildProgramBlackoutOverrideSection } from "./scte35.mjs";

// Defaults match Break Start/End's all-zero delivery/blackout flags and empty UPID;
// the Program Blackout Override vectors below override them.
function buildReference({
    segmentationEventId,
    segmentationTypeId,
    ptsTime,
    deliveryNotRestricted = false,
    webDeliveryAllowed = false,
    noRegionalBlackout = false,
    archiveAllowed = false,
    deviceRestrictions = 0,
    upidType = 0,
    upid = new Uint8Array(0),
}) {
    const descriptor = new NewSegmentationDescriptor();
    descriptor.tag = 0x02; // SPLICE_DESCRIPTOR_SEGMENTATION variant discriminator
    descriptor.identifier = "CUEI";
    descriptor.remainder = new Uint8Array(0);
    descriptor.eventId = segmentationEventId;
    descriptor.canceled = false;
    descriptor.hasProgram = true;
    descriptor.hasDuration = false;
    descriptor.deliveryNotRestricted = deliveryNotRestricted;
    descriptor.webDeliveryAllowed = webDeliveryAllowed;
    descriptor.noRegionalBlackout = noRegionalBlackout;
    descriptor.archiveAllowed = archiveAllowed;
    descriptor.deviceRestrictions = deviceRestrictions;
    descriptor.components = [];
    descriptor.upidType = upidType;
    descriptor.upidLength = upid.length; // drives the upid field's own bit length -- see syntax.d.ts
    descriptor.upid = upid;
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
    // Program Blackout Override (0x18) -- exercises the delivery/blackout flags
    // and the URI-typed UPID, neither of which Break Start/End ever touch.
    {
        segmentationEventId: 5000,
        segmentationTypeId: SEGMENTATION_TYPE.PROGRAM_BLACKOUT_OVERRIDE,
        ptsTime: 2702250n,
        blackout: { blackedOut: true, alternateUpid: "moqt://localhost/blackout-alt-content.hang" },
    },
    {
        segmentationEventId: 5000,
        segmentationTypeId: SEGMENTATION_TYPE.PROGRAM_BLACKOUT_OVERRIDE,
        ptsTime: 3242250n,
        blackout: { blackedOut: false },
    },
];

let fail = 0;
for (const vector of VECTORS) {
    const { segmentationEventId, segmentationTypeId, ptsTime, blackout } = vector;

    let ours;
    let theirs;
    if (blackout) {
        ours = buildProgramBlackoutOverrideSection({ segmentationEventId, ptsTime, ...blackout });
        const upidUri = blackout.blackedOut ? blackout.alternateUpid : undefined;
        theirs = buildReference({
            segmentationEventId,
            segmentationTypeId,
            ptsTime,
            deliveryNotRestricted: false,
            webDeliveryAllowed: true,
            noRegionalBlackout: !blackout.blackedOut,
            archiveAllowed: true,
            deviceRestrictions: 0b11,
            upidType: upidUri ? 0x0f : 0,
            upid: upidUri ? new TextEncoder().encode(upidUri) : new Uint8Array(0),
        });
    } else {
        ours = buildTimeSignalSection(vector);
        theirs = buildReference(vector);
    }

    const ok = ours.equals(theirs);
    const label = `event=${segmentationEventId} type=0x${segmentationTypeId.toString(16)} pts=${ptsTime}`;
    if (ok) {
        console.log(`PASS  ${label}`);
    } else {
        fail = 1;
        console.log(`FAIL  ${label}`);
        console.log(hexDiff(ours, theirs));
    }
}
process.exit(fail);
