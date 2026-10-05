import { STATUS_LABEL } from "../lib/format.js";

const DOT = {
    good: "bg-good",
    warning: "bg-warning",
    critical: "bg-critical",
    idle: "bg-ink-3/50",
};

const BADGE = {
    good: "border-good/40 bg-good/10",
    warning: "border-warning/40 bg-warning/10",
    critical: "border-critical/40 bg-critical/10",
    idle: "border-line bg-surface-2",
};

// Color is never the only signal: every dot travels with a text label.
function StatusDot({ status, pulse = false }) {
    return (
        <span className="relative inline-flex size-2 shrink-0">
            {pulse && status === "good" && (
                <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT[status]}`} />
            )}
            <span className={`relative inline-flex size-2 rounded-full ${DOT[status]}`} />
        </span>
    );
}

export function StatusBadge({ status, children, pulse = false }) {
    return (
        <span
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium text-ink ${BADGE[status]}`}
        >
            <StatusDot status={status} pulse={pulse} />
            {children ?? STATUS_LABEL[status]}
        </span>
    );
}

export function StatusLine({ status, label }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <StatusDot status={status} />
            {label ?? STATUS_LABEL[status]}
        </span>
    );
}
