import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Stat } from "./components/Card.jsx";
import { LineChart } from "./components/LineChart.jsx";
import { LogStream } from "./components/LogStream.jsx";
import { StatusBadge } from "./components/Status.jsx";
import { fetchConfig, measureClockOffset, relayUrlFor, subscribeEvents } from "./lib/api.js";
import { DASH, duration, fixed, grade, gradeFps, mbps, THRESHOLDS } from "./lib/format.js";
import { StreamMonitor } from "./lib/monitor.js";

const MAX_LOG_LINES = 2000;
const CLOCK_RESYNC_MS = 30000;

const MODE_LABEL = {
    base: "No ads",
    ssai: "SSAI",
    csai: "CSAI · SCTE-35",
    sgai: "SGAI · Event Timeline",
};

const CONNECTION = {
    connecting: { status: "warning", label: "Connecting" },
    waiting: { status: "warning", label: "Waiting for broadcast" },
    live: { status: "good", label: "Live" },
    reconnecting: { status: "critical", label: "Reconnecting" },
};

const TRANSPORT_LABEL = { "webtransport": "WebTransport (QUIC)", "websocket": "WebSocket fallback" };

export default function App() {
    const [config, setConfig] = useState(null);
    const [configError, setConfigError] = useState(null);
    const [snapshot, setSnapshot] = useState(null);
    const [lines, setLines] = useState([]);
    const [eventsConnected, setEventsConnected] = useState(false);
    const [ingestSeen, setIngestSeen] = useState(false);
    const [clockOffset, setClockOffset] = useState(null);
    const monitorRef = useRef(null);
    const pendingLines = useRef([]);

    useEffect(() => {
        fetchConfig().then(setConfig, (err) => setConfigError(err.message));
    }, []);

    useEffect(() => {
        if (!config) return;
        const monitor = new StreamMonitor({
            relayUrl: relayUrlFor(config),
            broadcast: config.broadcast,
            onSnapshot: setSnapshot,
        });
        monitorRef.current = monitor;
        return () => monitor.close();
    }, [config]);

    // Log lines can arrive in bursts (startup, ffmpeg errors); batch them into one
    // render per animation frame instead of one per line.
    useEffect(() => {
        let frame = 0;
        const flush = () => {
            frame = 0;
            const batch = pendingLines.current;
            pendingLines.current = [];
            setLines((prev) => {
                const next = prev.concat(batch);
                return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
            });
        };
        return subscribeEvents({
            onStatus: setEventsConnected,
            onLog: (line) => {
                pendingLines.current.push(line);
                if (!frame) frame = requestAnimationFrame(flush);
            },
            onIngest: (sample) => {
                setIngestSeen(true);
                monitorRef.current?.setIngest(sample);
            },
        });
    }, []);

    useEffect(() => {
        let cancelled = false;
        const sync = () =>
            measureClockOffset().then(
                ({ offset }) => {
                    if (cancelled) return;
                    setClockOffset(offset);
                    monitorRef.current?.setClockOffset(offset);
                },
                () => {},
            );
        sync();
        const timer = setInterval(sync, CLOCK_RESYNC_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [config]);

    const onRendition = useCallback((e) => monitorRef.current?.setRendition(e.target.value), []);

    if (configError) {
        return (
            <Shell>
                <div className="rounded-xl border border-critical/40 bg-critical/10 p-5 text-sm text-ink-2">
                    Could not reach the dashboard server ({configError}). Is the container still running?
                </div>
            </Shell>
        );
    }

    const s = snapshot ?? { connection: { state: "connecting" }, history: [], renditions: [] };
    const conn = CONNECTION[s.connection.state] ?? CONNECTION.connecting;
    const live = s.connection.state === "live";

    const rttStatus = grade(s.rtt, ...THRESHOLDS.rtt);
    const lossStatus = grade(s.loss, ...THRESHOLDS.loss);
    const jitterStatus = grade(s.jitter, ...THRESHOLDS.jitter);
    const latencyStatus = grade(s.latency, ...THRESHOLDS.latency);
    const fpsStatus = gradeFps(s.fps, s.video?.nominalFps);

    const latencyHint = !eventsConnected
        ? "Dashboard server unreachable"
        : !ingestSeen
          ? "Waiting for the ingest clock"
          : "Publisher ingest to browser arrival";

    return (
        <Shell>
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    <p className="font-mono text-xs text-ink-3">moq-lab / dashboard</p>
                    <h1 className="mt-1 truncate font-mono text-2xl font-semibold tracking-tight">
                        {config?.broadcast ?? DASH}
                    </h1>
                    <p className="mt-1 text-xs text-ink-3">
                        {config ? relayUrlFor({ ...config, jwt: null }) : DASH}
                        {s.connection.transport && ` · ${TRANSPORT_LABEL[s.connection.transport] ?? s.connection.transport}`}
                        {s.connection.version && ` · ${s.connection.version}`}
                        {live && s.connection.liveSince && ` · up ${duration(Date.now() - s.connection.liveSince)}`}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {config && (
                        <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-2">
                            {MODE_LABEL[config.mode] ?? config.mode}
                            {config.abrLadder && " · ABR ladder"}
                            {config.jwt && " · JWT"}
                        </span>
                    )}
                    <StatusBadge status={conn.status} pulse>
                        {conn.label}
                    </StatusBadge>
                </div>
            </header>

            {s.connection.error && !live && (
                <p className="rounded-lg border border-critical/40 bg-critical/10 px-4 py-2.5 font-mono text-xs text-ink-2">
                    {s.connection.error}
                </p>
            )}

            <Card title="Transport & QUIC" subtitle="Measured on this browser's own MoQ session to the relay">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                    <Stat
                        label="Connection"
                        value={conn.label}
                        status={conn.status}
                        statusLabel={s.connection.transport ? (TRANSPORT_LABEL[s.connection.transport] ?? s.connection.transport) : "No session"}
                        hint={s.connection.version ?? undefined}
                    />
                    <Stat
                        label="RTT"
                        value={fixed(s.rtt, 1)}
                        unit="ms"
                        status={rttStatus}
                        hint={s.rttSource ?? (live ? "Not reported by this browser" : undefined)}
                    />
                    <Stat
                        label="Packet loss"
                        value={fixed(s.loss, 2)}
                        unit="%"
                        status={lossStatus}
                        hint={s.loss !== null && s.loss !== undefined ? "Uplink, QUIC-declared lost" : live ? "Needs WebTransport stats" : undefined}
                    />
                    <Stat
                        label="Jitter"
                        value={fixed(s.jitter, 1)}
                        unit="ms"
                        status={jitterStatus}
                        hint="Video inter-arrival, RFC 3550"
                    />
                    <Stat
                        label="Bitrate"
                        value={fixed(s.bitrate, 2)}
                        unit="Mbps"
                        status={live ? "good" : "idle"}
                        statusLabel={live ? "Receiving" : "Idle"}
                        hint={s.bitrateSource ?? undefined}
                    />
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <LineChart title="Received bitrate" unit="Mbps" field="bitrate" digits={2} history={s.history} />
                    <LineChart
                        title="Round-trip time"
                        unit="ms"
                        field="rtt"
                        digits={1}
                        history={s.history}
                        emptyText={live ? "This browser reports no RTT for the session" : "Waiting for data"}
                    />
                </div>
            </Card>

            <Card
                title="Media stream"
                subtitle={s.video ? `Video track ${s.video.rendition}${s.audio ? ` · audio track ${s.audio.rendition}` : ""}` : "From the broadcast's catalog and the frames it delivers"}
                aside={
                    s.renditions.length > 1 && (
                        <label className="flex items-center gap-2 text-xs text-ink-3">
                            Rendition
                            <select
                                value={s.video?.rendition ?? ""}
                                onChange={onRendition}
                                className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs text-ink focus:border-series focus:outline-none"
                            >
                                {s.renditions.map((r) => (
                                    <option key={r.name} value={r.name}>
                                        {r.height ? `${r.height}p` : r.name} · {mbps(r.bitrate)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )
                }
            >
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <Stat
                        label="Resolution"
                        value={s.video?.width ? `${s.video.width}×${s.video.height}` : DASH}
                        hint={s.video?.bitrate ? `Encoded at ${mbps(s.video.bitrate)}` : undefined}
                    />
                    <Stat
                        label="Frame rate"
                        value={fixed(s.fps, 1)}
                        unit="fps"
                        status={fpsStatus}
                        hint={s.video?.nominalFps ? `Nominal ${s.video.nominalFps.toFixed(2)} fps from timestamps` : undefined}
                    />
                    <Stat
                        label="End-to-end latency"
                        value={fixed(s.latency, 0)}
                        unit="ms"
                        status={latencyStatus}
                        hint={latencyHint}
                    />
                    <Stat
                        label="Codec"
                        value={s.video?.codec ?? DASH}
                        hint={
                            s.audio
                                ? `Audio ${s.audio.codec}, ${(s.audio.sampleRate / 1000).toFixed(1)} kHz, ${s.audio.channels}ch`
                                : undefined
                        }
                    />
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <LineChart
                        title="End-to-end latency"
                        unit="ms"
                        field="latency"
                        history={s.history}
                        emptyText={ingestSeen ? "Waiting for data" : "Waiting for the ingest clock"}
                        note={
                            clockOffset !== null
                                ? `Excludes decode and render. Host/container clock offset corrected: ${clockOffset >= 0 ? "+" : ""}${clockOffset.toFixed(0)} ms.`
                                : "Excludes decode and render."
                        }
                    />
                    <LineChart title="Received frame rate" unit="fps" field="fps" digits={1} history={s.history} />
                </div>
            </Card>

            <Card title="Container logs" subtitle="stdout and stderr of run-stream.sh and everything it starts">
                <LogStream lines={lines} connected={eventsConnected} onClear={() => setLines([])} />
            </Card>
        </Shell>
    );
}

function Shell({ children }) {
    return <main className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-6 sm:px-6 lg:py-8">{children}</main>;
}
