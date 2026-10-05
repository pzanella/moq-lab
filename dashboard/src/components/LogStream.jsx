import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clockTimeMillis } from "../lib/format.js";
import { StatusLine } from "./Status.jsx";

function lineTone(text) {
    if (/\b(error|fail(ed|ure)?|panic|fatal)\b/i.test(text)) return "text-critical";
    if (/\bwarn(ing)?\b/i.test(text)) return "text-warning";
    return "text-ink-2";
}

// Splits a leading "[TAG]" (the prefix every script in this repo logs with) so it
// can be dimmed and the message itself stays readable.
function splitTag(text) {
    const m = /^(\[[^\]]+\])\s?(.*)$/.exec(text);
    return m ? [m[1], m[2]] : [null, text];
}

export function LogStream({ lines, connected, onClear }) {
    const scrollRef = useRef(null);
    const [follow, setFollow] = useState(true);
    const [filter, setFilter] = useState("");

    const visible = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
    }, [lines, filter]);

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (follow && el) el.scrollTop = el.scrollHeight;
    }, [visible, follow]);

    // Scrolling up pauses auto-follow; scrolling back to the bottom resumes it.
    useEffect(() => {
        const el = scrollRef.current;
        const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, []);

    const button =
        "rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-series";

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <StatusLine
                    status={connected ? "good" : "critical"}
                    label={connected ? "Streaming from container" : "Log stream disconnected"}
                />
                <span className="text-xs text-ink-3">
                    {visible.length === lines.length ? `${lines.length} lines` : `${visible.length} of ${lines.length} lines`}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <input
                        type="search"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter"
                        aria-label="Filter log lines"
                        className="w-40 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-series focus:outline-none"
                    />
                    <button type="button" className={button} onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
                        {follow ? "Pause" : "Follow"}
                    </button>
                    <button type="button" className={button} onClick={onClear}>
                        Clear
                    </button>
                </div>
            </div>
            <div
                ref={scrollRef}
                role="log"
                aria-live="off"
                className="h-[26rem] overflow-auto rounded-lg border border-line bg-terminal px-4 py-3 font-mono text-[12px] leading-5"
            >
                {visible.length === 0 ? (
                    <p className="text-ink-3">{lines.length ? "No lines match the filter." : "Waiting for output from the container..."}</p>
                ) : (
                    visible.map((line) => {
                        const [tag, message] = splitTag(line.text);
                        return (
                            <div key={line.seq} className="flex gap-3 whitespace-pre-wrap break-all">
                                <span className="shrink-0 text-ink-3/70 select-none tabular-nums">{clockTimeMillis(line.t)}</span>
                                <span className={lineTone(line.text)}>
                                    {tag && <span className="text-ink-3">{tag} </span>}
                                    {message}
                                </span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
