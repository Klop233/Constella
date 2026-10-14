import { useEffect, useRef, useState } from "react";

export interface LineSeries {
  name: string;
  /** Any CSS color from the theme (`var(--color-accent)`, `var(--series-1)`…). */
  color: string;
  values: (number | null)[];
}

/** A clean top for the axis; with even data the midline tick is a whole number too. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((k) => k * p >= v) ?? 10) * p;
}

/**
 * Line chart for samples over time: hairline grid, a crosshair on hover with the value of every series,
 * and a visually hidden table for screen readers. Colors come from the theme tokens. The width is measured
 * so the 2px line and the hover dots keep their real size on a phone, where the SVG is stretched.
 */
export function LineChart({
  series,
  labels,
  ticks,
  format = String,
  tickFormat,
  max,
  height = 150,
  title,
}: {
  series: LineSeries[];
  /** Tooltip label for every sample: `labels[i]` belongs to `values[i]` of each series. */
  labels: string[];
  /** Axis label for every sample; empty string to skip the tick. */
  ticks: string[];
  format?: (v: number) => string;
  tickFormat?: (v: number) => string;
  /** Fixed axis top (a share 0–1, a known core count); the default is a round number above the data. */
  max?: number;
  height?: number;
  title: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const axis = tickFormat ?? format;
  const W = Math.max(160, w);
  const padL = 44;
  const padB = 20;
  const padT = 8;
  const plotH = height - padB - padT;
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  const top = max ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => (v == null || !Number.isFinite(v) ? 0 : v)))));
  const x = (i: number) => (n <= 1 ? padL : padL + (i / (n - 1)) * (W - padL));
  const y = (v: number) => padT + plotH - (Math.min(Math.max(v, 0), top) / top) * plotH;
  const path = (values: (number | null)[]) => {
    let d = "";
    let open = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) {
        open = false;
        continue;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      open = true;
    }
    return d;
  };
  const at = hover != null && hover >= 0 && hover < n ? hover : null;
  const rows = at == null ? [] : series.map((s) => ({ s, v: s.values[at] ?? null }));
  const topY = rows.reduce((m, r) => (r.v == null ? m : Math.min(m, y(r.v))), Number.POSITIVE_INFINITY);
  // A day of samples would be a very long hidden table; keep roughly one row per 60.
  const step = Math.max(1, Math.ceil(n / 60));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="w-full block"
        style={{ height }}
        role="img"
        aria-label={title}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (n <= 1 || !r.width) return;
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.min(n - 1, Math.max(0, Math.round(((px - padL) / (W - padL)) * (n - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        {[0, top / 2, top].map((t) => (
          <line key={t} x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {at != null && <line x1={x(at)} x2={x(at)} y1={padT} y2={padT + plotH} stroke="var(--muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {/* Axis text and the tooltip as HTML so they don't stretch with the SVG. */}
      <div className="pointer-events-none absolute inset-0 text-[11px] text-muted tabular-nums">
        {[0, top / 2, top].map((t) => (
          <span key={t} className="absolute left-0 -translate-y-1/2" style={{ top: y(t) }}>
            {axis(t)}
          </span>
        ))}
        {ticks.map((label, i) =>
          label ? (
            <span key={i} className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${(x(i) / W) * 100}%` }}>
              {label}
            </span>
          ) : null,
        )}
        {at != null && Number.isFinite(topY) && (
          <>
            {rows.map(({ s, v }) =>
              v == null ? null : <span key={s.name} className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line" style={{ left: `${(x(at) / W) * 100}%`, top: y(v), background: s.color }} />,
            )}
            <div
              className="absolute -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface shadow-lg px-2 py-1 text-xs text-[var(--text)] whitespace-nowrap"
              style={{ left: `${(Math.min(Math.max(x(at), 60), W - 60) / W) * 100}%`, top: Math.max(0, topY - 8) }}
            >
              <div className="text-muted">{labels[at]}</div>
              {rows.map(({ s, v }) => (
                <div key={s.name} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full shrink-0" style={{ background: s.color }} />
                  <span className="flex-1 pr-2">{s.name}</span>
                  <span className="font-medium tabular-nums">{v == null ? "—" : format(v)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>时间</th>
            {series.map((s) => (
              <th key={s.name}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) =>
            i % step === 0 ? (
              <tr key={i}>
                <th>{label}</th>
                {series.map((s) => {
                  const v = s.values[i];
                  return <td key={s.name}>{v == null ? "—" : format(v)}</td>;
                })}
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
    </div>
  );
}
