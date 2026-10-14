import type { ReactNode } from "react";
import { LineChart, type LineSeries } from "./LineChart";
import { bytes, cores, rate, type PerfPoint } from "../lib/perf";

/** `15:20` for a sample timestamp; the axis and the tooltip both use it. */
export const hmTime = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Short axis labels, so they don't run into the plot on a phone. */
export const compactBytes = (v: number) => (v === 0 ? "0" : bytes(v).replace(" ", ""));
export const compactRate = (v: number) => (v === 0 ? "0" : rate(v).replace(" ", ""));
export const compactCores = (v: number) => (v === 0 ? "0" : cores(v).replace(" ", ""));

/** Tooltip and axis labels for a list of samples, with about five ticks across the range. */
export function timeScale(list: PerfPoint[]): { labels: string[]; ticks: string[] } {
  const step = Math.max(1, Math.ceil(list.length / 5));
  return { labels: list.map((p) => hmTime(p.t)), ticks: list.map((p, i) => (i % step === 0 ? hmTime(p.t) : "")) };
}

export interface PerfSeriesDef {
  name: string;
  /** Defaults to the accent for the first series and `--series-N` order for the rest. */
  color?: string;
  value: (p: PerfPoint) => number | null;
}

/** One titled chart of performance samples: a live value (or legend) on the right, then the curve. */
export function PerfChart({
  title,
  list,
  series,
  max,
  format,
  tickFormat,
  height = 150,
  right,
}: {
  title: string;
  list: PerfPoint[];
  series: PerfSeriesDef[];
  max?: number;
  format?: (v: number) => string;
  tickFormat?: (v: number) => string;
  height?: number;
  right?: ReactNode;
}) {
  const scale = timeScale(list);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <h3 className="shrink-0 text-[13px] font-medium">{title}</h3>
        <div className="flex-1 min-w-0" />
        {right}
      </div>
      {list.length < 2 ? (
        <div className="py-10 text-center text-xs text-muted">刚开始采样，等一两分钟就有曲线了</div>
      ) : (
        <LineChart
          title={title}
          labels={scale.labels}
          ticks={scale.ticks}
          height={height}
          max={max}
          format={format}
          tickFormat={tickFormat}
          series={series.map((s, i): LineSeries => ({ name: s.name, color: s.color ?? (i === 0 ? "var(--color-accent)" : `var(--series-${i + 1})`), values: list.map(s.value) }))}
        />
      )}
    </div>
  );
}
