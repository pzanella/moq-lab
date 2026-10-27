import "@moq/watch/element";
import { useCallback, useEffect, useRef, useState } from "react";
import { DASH } from "../lib/format.js";
import { EventTimeline, SEGMENTATION_TYPE, SEGMENTATION_TYPE_NAMES, upidBroadcast } from "../lib/sgai.js";
import { Card } from "./Card.jsx";
import { StatusBadge } from "./Status.jsx";

const MAX_RECORDS = 12;
const MAX_SWITCHES = 20;

const TIMELINE_STATE = {
    connecting: { status: "warning", label: "Connecting" },
    waiting: { status: "warning", label: "Waiting for events" },
    live: { status: "good", label: "Events live" },
    reconnecting: { status: "critical", label: "Reconnecting" },
};

// Plays the stream with @moq/watch. With --sgai-mode it also acts on the Event
// Timeline, as the SGAI-over-MOQ spec's subscriber does: Ad Start names the ad
// broadcast, Placement Opportunity Start switches to it, Placement Opportunity End
// switches back to the content, and a Program Blackout Override covers the content.
export function Player({ config, relayUrl }) {
    // `seq` gives every switch its own <moq-watch> (see Watch below).
    const [view, setView] = useState({ kind: "content", broadcast: config.broadcast, seq: 0 });
    const [muted, setMuted] = useState(true);
    const [blackout, setBlackout] = useState(null);
    const [timelineState, setTimelineState] = useState(null);
    const [records, setRecords] = useState([]);
    const [switches, setSwitches] = useState([]);
    const adBroadcast = useRef(null);
    const switchedAt = useRef(null);

    const switchTo = useCallback((kind, broadcast) => {
        switchedAt.current = performance.now();
        setView((prev) => ({ kind, broadcast, seq: prev.seq + 1 }));
    }, []);

    // Switch time: from the moment the player acted on the record to the first frame
    // drawn from the new broadcast.
    const onFirstFrame = useCallback((kind) => {
        if (switchedAt.current === null) return;
        const ms = performance.now() - switchedAt.current;
        switchedAt.current = null;
        setSwitches((prev) => [...prev, { kind, ms }].slice(-MAX_SWITCHES));
    }, []);

    useEffect(() => {
        if (!config.eventsBroadcast) return;
        const timeline = new EventTimeline({
            relayUrl,
            broadcast: config.eventsBroadcast,
            onState: setTimelineState,
            onRecord: (record) => {
                const { data } = record;
                setRecords((prev) => [{ ...record, at: Date.now() }, ...prev].slice(0, MAX_RECORDS));
                switch (data.segmentation_type_id) {
                    case SEGMENTATION_TYPE.AD_START:
                        adBroadcast.current = upidBroadcast(data.segmentation_upid_uri);
                        break;
                    case SEGMENTATION_TYPE.PLACEMENT_OPPORTUNITY_START:
                        if (adBroadcast.current) switchTo("ad", adBroadcast.current);
                        break;
                    case SEGMENTATION_TYPE.PLACEMENT_OPPORTUNITY_END:
                        adBroadcast.current = null;
                        switchTo("content", config.broadcast);
                        break;
                    case SEGMENTATION_TYPE.PROGRAM_BLACKOUT_OVERRIDE:
                        setBlackout(data.no_regional_blackout_flag === false ? (data.segmentation_upid_uri ?? "") : null);
                        break;
                    default:
                        break;
                }
            },
        });
        return () => timeline.close();
    }, [config, relayUrl, switchTo]);

    const timeline = timelineState && (TIMELINE_STATE[timelineState] ?? TIMELINE_STATE.connecting);
    const lastToAd = [...switches].reverse().find((s) => s.kind === "ad");
    const lastToContent = [...switches].reverse().find((s) => s.kind === "content");

    return (
        <Card
            title="Player"
            subtitle={`Playing ${view.broadcast} with @moq/watch`}
            aside={
                <div className="flex flex-wrap items-center gap-2">
                    {config.eventsBroadcast && (
                        <StatusBadge status={view.kind === "ad" ? "warning" : "good"}>
                            {view.kind === "ad" ? "Ad break" : "Content"}
                        </StatusBadge>
                    )}
                    {timeline && <StatusBadge status={timeline.status}>{timeline.label}</StatusBadge>}
                    <button
                        type="button"
                        onClick={() => setMuted((m) => !m)}
                        className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink-2 hover:text-ink"
                    >
                        {muted ? "Unmute" : "Mute"}
                    </button>
                </div>
            }
        >
            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="relative overflow-hidden rounded-lg border border-line bg-black">
                    <Watch
                        key={view.seq}
                        url={relayUrl}
                        name={view.broadcast}
                        muted={muted}
                        paused={blackout !== null}
                        onFirstFrame={() => onFirstFrame(view.kind)}
                    />
                    {blackout !== null && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/90 p-4 text-center">
                            <span className="text-sm font-semibold text-ink">Regional blackout</span>
                            <span className="font-mono text-xs break-all text-ink-3">
                                Alternate content: {blackout || "none given"}
                            </span>
                        </div>
                    )}
                </div>

                {config.eventsBroadcast ? (
                    <div className="flex min-w-0 flex-col gap-3">
                        <div className="grid grid-cols-2 gap-3">
                            <SwitchStat label="Switch to ad" value={lastToAd?.ms} />
                            <SwitchStat label="Back to content" value={lastToContent?.ms} />
                        </div>
                        <p className="text-[11px] text-ink-3">
                            From the event to the first frame drawn from the new broadcast. Includes the new
                            subscription, the first keyframe, and decoding.
                        </p>
                        <ol className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2/60 font-mono text-xs">
                            {records.length === 0 && <li className="px-3 py-2 text-ink-3">No events yet</li>}
                            {records.map((r) => (
                                <li key={`${r.at}-${r.data.segmentation_event_id}-${r.data.segmentation_type_id}-${r.m}`} className="flex justify-between gap-3 px-3 py-2">
                                    <span className="truncate text-ink-2">
                                        {SEGMENTATION_TYPE_NAMES[r.data.segmentation_type_id] ?? r.data.segmentation_type_id}
                                    </span>
                                    <span className="shrink-0 text-ink-3">
                                        id {r.data.segmentation_event_id} · m {r.m}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </div>
                ) : (
                    <p className="text-xs text-ink-3">
                        Start the stream with --sgai-mode to see the player switch between the content and ad
                        broadcasts here.
                    </p>
                )}
            </div>
        </Card>
    );
}

// One <moq-watch> per broadcast. A switch mounts a new one and unmounts the old one,
// which closes its subscription: the UNSUBSCRIBE/RESUBSCRIBE of the SGAI spec. Changing
// `name` on one element instead reuses its video pipeline, and the first frames of the
// new broadcast then fail to decode (content and ad share the track name 0.m4s).
function Watch({ url, name, muted, paused, onFirstFrame }) {
    const ref = useRef(null);
    const onFirstFrameRef = useRef(onFirstFrame);
    onFirstFrameRef.current = onFirstFrame;

    useEffect(() => {
        const el = ref.current;
        el.setAttribute("url", url);
        el.setAttribute("name", name);
        el.toggleAttribute("muted", muted);
        el.toggleAttribute("paused", paused);
    }, [url, name, muted, paused]);

    useEffect(() => {
        let done = false;
        const stop = ref.current.renderer.out.frame.subscribe((frame) => {
            if (!frame || done) return;
            done = true;
            onFirstFrameRef.current();
        });
        return stop;
    }, []);

    return (
        <moq-watch ref={ref}>
            <canvas className="block aspect-video w-full" />
        </moq-watch>
    );
}

function SwitchStat({ label, value }) {
    return (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2/60 p-3">
            <span className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">{label}</span>
            <span className="font-mono text-xl text-ink tabular-nums">
                {value === undefined ? DASH : Math.round(value)}
                {value !== undefined && <span className="ml-1 text-xs text-ink-3">ms</span>}
            </span>
        </div>
    );
}
