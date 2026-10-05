import {
    CategoryScale,
    Chart,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    Tooltip,
} from "chart.js";
import { useEffect, useRef } from "react";
import { clockTime } from "../lib/format.js";
import { HISTORY_SECONDS } from "../lib/monitor.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip);

const SERIES = "#3987e5";
const GRID = "#2c2c2a";
const TICK = "#8b8a83";

// Vertical hairline at the hovered X, so the reader aims at a time, not at a 2px line.
const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.() ?? [];
        if (!active.length) return;
        const { ctx, chartArea } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = "#5a5954";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    },
};

// One series per chart, so no legend: the card title names it.
export function LineChart({ title, unit, history, field, digits = 0, emptyText = "Waiting for data", note }) {
    const canvasRef = useRef(null);
    const chartRef = useRef(null);

    useEffect(() => {
        chartRef.current = new Chart(canvasRef.current, {
            type: "line",
            data: { labels: [], datasets: [{ data: [], borderColor: SERIES, backgroundColor: SERIES }] },
            plugins: [crosshair],
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                elements: {
                    line: { borderWidth: 2, cubicInterpolationMode: "monotone" },
                    point: { radius: 0, hoverRadius: 4, hoverBorderWidth: 2, hoverBorderColor: "#1a1a19" },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { color: GRID },
                        ticks: { color: TICK, maxTicksLimit: 4, maxRotation: 0, font: { size: 10 } },
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: GRID, drawTicks: false },
                        border: { display: false },
                        ticks: { color: TICK, maxTicksLimit: 4, padding: 6, font: { size: 10 } },
                    },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#262624",
                        borderColor: "#3a3a37",
                        borderWidth: 1,
                        titleColor: "#c3c2b7",
                        titleFont: { size: 11, weight: "normal" },
                        bodyColor: "#ffffff",
                        bodyFont: { size: 13, weight: "600" },
                        padding: 10,
                        displayColors: false,
                    },
                },
            },
        });
        return () => chartRef.current?.destroy();
    }, []);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.data.labels = history.map((p) => clockTime(p.t));
        chart.data.datasets[0].data = history.map((p) => p[field] ?? null);
        chart.options.plugins.tooltip.callbacks = {
            label: (item) => (item.raw === null ? "no sample" : `${item.raw.toFixed(digits)} ${unit}`),
        };
        chart.update("none");
    }, [history, field, unit, digits]);

    const empty = !history.some((p) => p[field] !== null && p[field] !== undefined);
    const latest = [...history].reverse().find((p) => p[field] !== null && p[field] !== undefined)?.[field];

    return (
        <figure className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-2/60 p-4">
            <figcaption className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-ink-2">
                    {title} <span className="text-ink-3">
                        ({unit}, last {HISTORY_SECONDS / 60} min)
                    </span>
                </span>
                {latest !== undefined && (
                    <span className="font-mono text-xs text-ink tabular-nums">
                        {latest.toFixed(digits)} {unit}
                    </span>
                )}
            </figcaption>
            <div className="relative h-40">
                <canvas ref={canvasRef} role="img" aria-label={`${title} over the last ${HISTORY_SECONDS / 60} minutes`} />
                {empty && (
                    <div className="absolute inset-0 flex items-center justify-center text-center text-xs text-ink-3">
                        {emptyText}
                    </div>
                )}
            </div>
            {note && <p className="text-[11px] text-ink-3">{note}</p>}
        </figure>
    );
}
