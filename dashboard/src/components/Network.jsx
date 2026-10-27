import { useEffect, useState } from "react";
import { fetchNetem, setNetem } from "../lib/api.js";
import { Card } from "./Card.jsx";
import { StatusBadge } from "./Status.jsx";

// Switches stream.sh --netem's network profile while the stream runs. The charts
// below show what the change does to RTT, loss, jitter, bitrate, and latency.
export function Network({ profiles }) {
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        fetchNetem().then(setState, (err) => setError(err.message));
    }, []);

    const onChange = async (e) => {
        setBusy(true);
        setError(null);
        try {
            setState(await setNetem(e.target.value));
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const shaped = state?.profile && state.profile !== "off";

    return (
        <Card
            title="Network lab"
            subtitle="Shapes the traffic from the container to its viewers (Linux netem)"
            aside={
                <StatusBadge status={shaped ? "warning" : "good"}>{shaped ? "Shaped" : "Not shaped"}</StatusBadge>
            }
        >
            <div className="flex flex-col gap-3">
                <label className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    Profile
                    <select
                        value={state?.profile ?? ""}
                        onChange={onChange}
                        disabled={busy || !state}
                        className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs text-ink focus:border-series focus:outline-none disabled:opacity-60"
                    >
                        {Object.entries(profiles).map(([name, label]) => (
                            <option key={name} value={name}>
                                {label}
                            </option>
                        ))}
                    </select>
                </label>
                <p className="font-mono text-xs break-all text-ink-3">{state?.shaping || "tc: no root qdisc"}</p>
                {error && <p className="font-mono text-xs text-critical">{error}</p>}
                <p className="text-[11px] text-ink-3">
                    Only outgoing traffic is shaped, so the delay is one way: the RTT goes up by the delay, not
                    twice. The ingest pipeline inside the container is not affected.
                </p>
            </div>
        </Card>
    );
}
