// Event Timeline record builders for the org.scte.scte35.v1 type, per the
// SGAI-over-MOQ / SCTE-35-Based Event Timeline Type Definition spec (sections
// 3.2-3.6 and the 4.1 ad-break example). Each record is
// { m: <media_time_ms>, data: { <scte35_fields> } }.

export const SEGMENTATION_TYPE = {
    PROVIDER_PLACEMENT_OPPORTUNITY_START: "0x34",
    PROVIDER_PLACEMENT_OPPORTUNITY_END: "0x35",
    PROVIDER_ADVERTISEMENT_START: "0x30",
    PROVIDER_ADVERTISEMENT_END: "0x31",
    PROGRAM_BLACKOUT_OVERRIDE: "0x18",
};

export const SEGMENTATION_TYPE_NAMES = {
    [SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_START]: "Placement Opportunity Start",
    [SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_END]: "Placement Opportunity End",
    [SEGMENTATION_TYPE.PROVIDER_ADVERTISEMENT_START]: "Ad Start",
    [SEGMENTATION_TYPE.PROVIDER_ADVERTISEMENT_END]: "Ad End",
    [SEGMENTATION_TYPE.PROGRAM_BLACKOUT_OVERRIDE]: "Program Blackout Override",
};

const UPID_TYPE_URI = "0x0F";

export function placementOpportunityStart(m, eventId) {
    return {
        m,
        data: {
            segmentation_type_id: SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_START,
            segmentation_event_id: eventId,
        },
    };
}

export function placementOpportunityEnd(m, eventId) {
    return {
        m,
        data: {
            segmentation_type_id: SEGMENTATION_TYPE.PROVIDER_PLACEMENT_OPPORTUNITY_END,
            segmentation_event_id: eventId,
        },
    };
}

export function adStart(m, eventId, upidUri) {
    return {
        m,
        data: {
            segmentation_type_id: SEGMENTATION_TYPE.PROVIDER_ADVERTISEMENT_START,
            segmentation_event_id: eventId,
            segmentation_upid_type: UPID_TYPE_URI,
            segmentation_upid_uri: upidUri,
        },
    };
}

export function adEnd(m, eventId) {
    return {
        m,
        data: {
            segmentation_type_id: SEGMENTATION_TYPE.PROVIDER_ADVERTISEMENT_END,
            segmentation_event_id: eventId,
        },
    };
}

// Per SGAI-over-MOQ spec section 3.5 (Delivery Restriction and Control Fields)
// and the regional-blackout example (4.2): a Program Blackout Override record
// updates the program's delivery restriction flags. Call it twice with the
// same eventId -- once with blackedOut: true (+ alternateUpid, if the
// affiliate should switch to alternate content) to start the blackout, once
// with blackedOut: false to restore normal distribution.
export function programBlackoutOverride(m, eventId, { blackedOut, alternateUpid } = {}) {
    const data = {
        segmentation_type_id: SEGMENTATION_TYPE.PROGRAM_BLACKOUT_OVERRIDE,
        segmentation_event_id: eventId,
        delivery_not_restricted_flag: false,
        web_delivery_allowed_flag: true,
        no_regional_blackout_flag: !blackedOut,
        archive_allowed_flag: true,
        device_restrictions: 3,
    };
    if (blackedOut && alternateUpid) {
        data.segmentation_upid_type = UPID_TYPE_URI;
        data.segmentation_upid_uri = alternateUpid;
    }
    return { m, data };
}
