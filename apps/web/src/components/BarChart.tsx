import { useState } from "react";

export interface BarDatum {
  label: string;
  /** Short axis label; empty to skip the tick. */
  tick: string;
  value: number;
}

/** A clean top for the axis; with integer data it stays even so the midline tick is a whole number too. */
function niceMax(v: number, integer: boolean): number {
  if (v <= 0) return integer ? 2 : 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = ([1, 2, 2.5, 5, 10].find((k) => k * p >= v) ?? 10) * p;
  return integer ? Math.max(2, Math.ceil(m / 2) * 2) : m;
}

/**
 * Single-series column chart: ≤24px columns with a rounded data end, hairline grid, hover tooltip,
 * and a visually hidden table for screen readers. Colors come from the theme tokens.
 */
export function BarChart({ data, format = String, height = 180, title }: { data: BarDatum[]; format?: (v: number) => string; height?: number; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = data.map((d) => d.value);
  const max = niceMax(Math.max(0, ...values), values.every(Number.isInteger));
  const ticks = [0, max / 2, max];
  const W = 1000;
  const padL = 44;
  const padB = 22;
  const plotH = height - padB - 8;
  const slot = (W - padL) / Math.max(1, data.length);
  const bw = Math.min(24 * (W / 700), slot - 2);
  const y = (v: number) => 8 + plotH - (v / max) * plotH;
  const h = hover != null ? data[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label={title} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          const top = y(d.value);
          const bh = Math.max(0, 8 + plotH - top);
          const r = Math.min(4, bh, bw / 2);
          return (
            <g key={d.label} onPointerEnter={() => setHover(i)}>
              <rect x={padL + i * slot} y={0} width={slot} height={height - padB} fill="transparent" />
              {bh > 0 && (
                <path
                  d={`M${x},${8 + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${8 + plotH} Z`}
                  fill="var(--color-accent)"
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              )}
            </g>
          );
        })}
      </svg>
      {/* Axis text as HTML so it doesn't stretch with the SVG. */}
      <div className="pointer-events-none absolute inset-0 text-[11px] text-muted tabular-nums">
        {ticks.map((t) => (
          <span key={t} className="absolute left-0 -translate-y-1/2" style={{ top: y(t) }}>
            {format(t)}
          </span>
        ))}
        {data.map((d, i) =>
          d.tick ? (
            <span key={d.label} className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${((padL + (i + 0.5) * slot) / W) * 100}%` }}>
              {d.tick}
            </span>
          ) : null,
        )}
        {h && hover != null && (
          <div
            className="absolute -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface shadow-lg px-2 py-1 text-xs text-[var(--text)] whitespace-nowrap"
            style={{ left: `${((padL + (hover + 0.5) * slot) / W) * 100}%`, top: y(h.value) - 6 }}
          >
            <span className="text-muted">{h.label}</span> <span className="font-medium">{format(h.value)}</span>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th>{d.label}</th>
              <td>{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
