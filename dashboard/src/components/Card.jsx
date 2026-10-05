import { StatusLine } from "./Status.jsx";

export function Card({ title, subtitle, aside, children }) {
    return (
        <section className="rounded-xl border border-line bg-surface">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
                    {subtitle && <p className="mt-0.5 truncate text-xs text-ink-3">{subtitle}</p>}
                </div>
                {aside}
            </header>
            <div className="p-5">{children}</div>
        </section>
    );
}

export function Stat({ label, value, unit, status, statusLabel, hint }) {
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2/60 p-4">
            <span className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">{label}</span>
            <span className="flex items-baseline gap-1.5">
                <span
                    className="truncate font-mono text-2xl font-medium tracking-tight text-ink tabular-nums"
                    title={typeof value === "string" ? value : undefined}
                >
                    {value}
                </span>
                {unit && <span className="text-xs text-ink-3">{unit}</span>}
            </span>
            {status && <StatusLine status={status} label={statusLabel} />}
            {hint && <span className="truncate text-[11px] text-ink-3" title={hint}>{hint}</span>}
        </div>
    );
}
