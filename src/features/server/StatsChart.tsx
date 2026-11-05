import { useEffect, useRef, useState } from "react";

import { useT } from "../../lib/i18n";

export interface StatsPoint {
  t: number;
  v: number;
}

interface StatsChartProps {
  title: string;
  unit: string;
  kind: "line" | "spline";
  points: StatsPoint[];
  /** Original QtCharts y-axis starts at 100 for counters. */
  initialMax?: number;
}

const HEIGHT = 170;
const PAD_LEFT = 46;
const PAD_RIGHT = 10;
const PAD_TOP = 24;
const PAD_BOTTOM = 22;

function nextMax(value: number, initialMax: number): number {
  const base = Math.max(value, initialMax);
  if (base <= 0) return 10;
  return Math.ceil(base / 10) * 10;
}

function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Self-drawn replacement for ServerCharts.qml's QtCharts series. No chart
 * library: one SVG path per series, a 5-line y grid and HH:mm:ss x labels,
 * matching the original LineSeries/SplineSeries look.
 */
export default function StatsChart({ title, unit, kind, points, initialMax = 0 }: StatsChartProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(220, element.clientWidth)));
    observer.observe(element);
    setWidth(Math.max(220, element.clientWidth));
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const max = nextMax(
    points.reduce((acc, point) => Math.max(acc, point.v), 0),
    initialMax,
  );
  const first = points[0]?.t ?? 0;
  const last = points[points.length - 1]?.t ?? 0;
  const span = Math.max(1, last - first);

  const xFor = (t: number) =>
    points.length === 1 ? PAD_LEFT + plotWidth / 2 : PAD_LEFT + ((t - first) / span) * plotWidth;
  const yFor = (v: number) => PAD_TOP + plotHeight - (Math.max(0, v) / max) * plotHeight;

  let path = "";
  if (points.length > 0) {
    const coords = points.map((point) => [xFor(point.t), yFor(point.v)] as const);
    if (kind === "spline" && coords.length > 2) {
      path = `M ${coords[0][0]} ${coords[0][1]}`;
      for (let index = 0; index < coords.length - 1; index += 1) {
        const p0 = coords[Math.max(0, index - 1)];
        const p1 = coords[index];
        const p2 = coords[index + 1];
        const p3 = coords[Math.min(coords.length - 1, index + 2)];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
      }
    } else {
      path = `M ${coords.map(([x, y]) => `${x} ${y}`).join(" L ")}`;
    }
  }

  const latest = points[points.length - 1]?.v;
  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const ticks =
    points.length === 0
      ? []
      : points.length === 1
        ? [points[0].t]
        : [first, first + span / 2, last];

  return (
    <div ref={ref} className="rounded-sm border border-border bg-surface p-2">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="truncate t-content text-text" title={title}>
          {title}
        </span>
        <span className="ml-auto shrink-0 t-12 text-muted">
          {latest === undefined ? "—" : `${Math.round(latest * 100) / 100} ${unit}`}
        </span>
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label={title}>
        {gridLines.map((ratio) => {
          const y = PAD_TOP + plotHeight * ratio;
          const value = max * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotWidth}
                y1={y}
                y2={y}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
              />
              <text x={PAD_LEFT - 4} y={y + 3} textAnchor="end" className="fill-muted" fontSize={9}>
                {Math.round(value * 100) / 100}
              </text>
            </g>
          );
        })}
        {path ? (
          <path d={path} fill="none" className="stroke-accent" strokeWidth={1.5} />
        ) : (
          <text
            x={PAD_LEFT + plotWidth / 2}
            y={PAD_TOP + plotHeight / 2}
            textAnchor="middle"
            className="fill-muted"
            fontSize={11}
          >
            {t("chart.waiting")}
          </text>
        )}
        {ticks.map((tick, index) => (
          <text
            key={`${tick}-${index}`}
            x={xFor(tick)}
            y={HEIGHT - 6}
            textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
            className="fill-muted"
            fontSize={9}
          >
            {timeLabel(tick)}
          </text>
        ))}
      </svg>
    </div>
  );
}
