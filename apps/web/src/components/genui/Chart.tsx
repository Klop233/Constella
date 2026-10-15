import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui";

// Charts for component blocks, drawn as SVG with the site's series colors, so they look like the
// rest of the app in every palette and mode. Data comes in one of two shapes:
//   rows:   data={[{name:"A", score:80}, …]} x="name" y={["score"]}   (y may be a string)
//   series: labels={["1月", …]} series={[{name:"收入", data:[…]}, …]}
// Pie and donut take one series (or `y`) and use the labels / x values as slices.

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter";
export type ValueFormat = "number" | "money" | "percent" | "compact";

export interface ChartProps {
  type?: ChartType;
  data?: Record<string, unknown>[];
  x?: string;
  y?: string | string[];
  labels?: unknown[];
  series?: { name?: string; data?: unknown[]; color?: string }[];
  /** Display names for `y` keys. */
  names?: Record<string, string>;
  height?: number;
  stacked?: boolean;
  horizontal?: boolean;
  format?: ValueFormat;
  unit?: string;
  min?: number;
  max?: number;
  legend?: boolean;
  colors?: string[];
  /** Highlight one category (index or label). */
  highlight?: number | string;
  title?: string;
}

interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}

const SERIES = (i: number) => `var(--series-${(i % 6) + 1})`;
const COLOR_WORDS: Record<string, string> = {
  accent: "var(--color-accent)", ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)", muted: "var(--muted)",
  blue: "var(--series-1)", orange: "var(--series-2)", teal: "var(--series-3)", yellow: "var(--series-4)", pink: "var(--series-5)", green: "var(--series-6)",
};
export const colorOf = (c: string | undefined, i: number) => (c ? (COLOR_WORDS[c] ?? (/^(#[0-9a-f]{3,8}|rgb|hsl|oklch|var\(--)/i.test(c) ? c : SERIES(i))) : SERIES(i));

const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/[,，%¥$]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function formatValue(v: number, format: ValueFormat = "number", unit = "", compact = false): string {
  const nf = (d: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: d });
  const abs = Math.abs(v);
  let s: string;
  if (format === "percent") s = `${nf(abs < 10 ? 1 : 0).format(v)}%`;
  else if (format === "compact" || (compact && abs >= 1e4)) s = abs >= 1e8 ? `${nf(1).format(v / 1e8)}亿` : abs >= 1e4 ? `${nf(1).format(v / 1e4)}万` : nf(abs < 10 ? 2 : 1).format(v);
  else s = nf(abs < 1 ? 3 : abs < 100 ? 2 : 0).format(v);
  if (format === "money") s = `¥${s}`;
  return unit ? `${s}${unit}` : s;
}

function normalize(p: ChartProps): { labels: string[]; series: Series[] } {
  if (p.series?.length) {
    const n = Math.max(0, ...p.series.map((s) => s.data?.length ?? 0));
    const labels = Array.from({ length: n }, (_, i) => String(p.labels?.[i] ?? i + 1));
    return { labels, series: p.series.map((s, i) => ({ name: String(s.name ?? `系列 ${i + 1}`), color: colorOf(s.color ?? p.colors?.[i], i), values: (s.data ?? []).map(toNum) })) };
  }
  const rows = Array.isArray(p.data) ? p.data.filter((r) => r && typeof r === "object") : [];
  if (!rows.length) return { labels: (p.labels ?? []).map(String), series: [] };
  const keys = Object.keys(rows[0]!);
  const xKey = p.x ?? keys.find((k) => toNum(rows[0]![k]) === null) ?? keys[0]!;
  const yKeys = p.y ? (Array.isArray(p.y) ? p.y : [p.y]) : keys.filter((k) => k !== xKey && rows.some((r) => toNum(r[k]) !== null));
  return {
    labels: rows.map((r) => String(r[xKey] ?? "")),
    series: yKeys.map((k, i) => ({ name: p.names?.[k] ?? k, color: colorOf(p.colors?.[i], i), values: rows.map((r) => toNum(r[k])) })),
  };
}

/** Shortens a label to about `px` wide (CJK characters count double). */
function fit(label: string, px: number): string {
  let w = 0;
  for (let i = 0; i < label.length; i++) {
    w += /[\u2e80-\uffff]/.test(label[i]!) ? 11.5 : 6.6;
    if (w > px) return `${label.slice(0, Math.max(1, i - 1))}…`;
  }
  return label;
}

/** Round tick values covering [lo, hi]. */
function ticks(lo: number, hi: number, count = 5): number[] {
  if (lo === hi) hi = lo + 1;
  const step0 = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Chart(props: ChartProps) {
  const type: ChartType = (["bar", "line", "area", "pie", "donut", "scatter"] as const).find((t) => t === props.type) ?? "bar";
  const { labels, series } = useMemo(() => normalize(props), [props]);
  const [ref, width] = useWidth();
  const height = Math.max(120, Math.min(Number(props.height) || (type === "pie" || type === "donut" ? 220 : 240), 640));
  const showLegend = props.legend ?? (type === "pie" || type === "donut" ? true : series.length > 1);
  return (
    <div className="space-y-2 min-w-0">
      {props.title && <div className="text-[13px] font-medium">{props.title}</div>}
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && series.length > 0 && (type === "pie" || type === "donut" ? <Pie {...{ labels, series, width, height, props, donut: type === "donut" }} /> : <Cartesian {...{ type, labels, series, width, height, props }} />)}
        {series.length === 0 && <div className="absolute inset-0 grid place-items-center text-xs text-muted">没有数据</div>}
      </div>
      {showLegend && (
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[12px] text-muted">
          {(type === "pie" || type === "donut" ? labels.map((l, i) => ({ name: l, color: colorOf(props.colors?.[i], i) })) : series).map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Tooltip({ x, y, width, title, rows, format, unit }: { x: number; y: number; width: number; title: string; rows: { name: string; color: string; value: number | null }[]; format?: ValueFormat; unit?: string }) {
  const left = Math.min(Math.max(8, x + 12), width - 168);
  return (
    <div className="pointer-events-none absolute z-10 w-40 rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-lg text-[12px]" style={{ left, top: Math.max(0, y - 10) }}>
      <div className="font-medium mb-0.5 truncate">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-1.5 tabular-nums">
          <span className="size-2 rounded-sm shrink-0" style={{ background: r.color }} />
          <span className="flex-1 truncate text-muted">{r.name}</span>
          <span>{r.value === null ? "—" : formatValue(r.value, format, unit)}</span>
        </div>
      ))}
    </div>
  );
}

function Cartesian({ type, labels, series, width, height, props }: { type: ChartType; labels: string[]; series: Series[]; width: number; height: number; props: ChartProps }) {
  const [hover, setHover] = useState<number | null>(null);
  const horizontal = type === "bar" && !!props.horizontal;
  const stacked = !!props.stacked && (type === "bar" || type === "area");
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((s, se) => s + Math.max(0, se.values[i] ?? 0), 0));
  const negs = labels.map((_, i) => series.reduce((s, se) => s + Math.min(0, se.values[i] ?? 0), 0));
  const all = stacked ? [...totals, ...negs] : series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all, 0);
  if (type === "line" || type === "scatter") {
    const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const vmin = Math.min(...vals);
    if (vmin > 0 && vmin > (hi - vmin) * 1.5) lo = vmin - (hi - vmin) * 0.15; // don't flatten a curve far above zero
  }
  if (props.min !== undefined && Number.isFinite(+props.min)) lo = +props.min;
  if (props.max !== undefined && Number.isFinite(+props.max)) hi = +props.max;
  const tk = ticks(lo, hi, height < 180 ? 3 : 4);
  lo = Math.min(lo, tk[0]!);
  hi = Math.max(hi, tk[tk.length - 1]!);
  const fmtTick = (v: number) => formatValue(v, props.format, props.unit, true);
  const labelW = horizontal ? Math.min(110, Math.max(...labels.map((l) => l.length * 12 + 8), 30)) : Math.min(72, Math.max(...tk.map((t) => fmtTick(t).length * 6.6 + 10), 28));
  const pad = { l: labelW, r: 10, t: 8, b: horizontal ? 22 : 26 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const val = (v: number) => (horizontal ? pad.l + ((v - lo) / (hi - lo)) * W : pad.t + H - ((v - lo) / (hi - lo)) * H);
  const band = (horizontal ? H : W) / Math.max(1, n);
  const pos = (i: number) => (horizontal ? pad.t : pad.l) + band * (i + 0.5);
  const skip = Math.max(1, Math.ceil((n * 44) / Math.max(1, horizontal ? H * 3 : W)));
  const hl = typeof props.highlight === "number" ? props.highlight : props.highlight !== undefined ? labels.indexOf(String(props.highlight)) : -1;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = horizontal ? e.clientY - r.top - pad.t : e.clientX - r.left - pad.l;
    const i = Math.floor(p / band);
    setHover(i >= 0 && i < n ? i : null);
  };

  const bars = () => {
    const groups = stacked ? 1 : series.length;
    const bw = Math.max(2, Math.min(band * 0.72, 56 * groups) / groups);
    const out: React.ReactNode[] = [];
    labels.forEach((_, i) => {
      let accP = 0;
      let accN = 0;
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === undefined) return;
        const base = stacked ? (v >= 0 ? accP : accN) : 0;
        const top = base + v;
        if (stacked) v >= 0 ? (accP = top) : (accN = top);
        const a = val(Math.max(lo, Math.min(base, top)));
        const b = val(Math.min(hi, Math.max(base, top)));
        const off = stacked ? -bw / 2 : -(bw * groups) / 2 + bw * si;
        const dim = hover !== null && hover !== i ? 0.45 : hl >= 0 && hl !== i ? 0.45 : 1;
        const rx = Math.min(4, bw / 3);
        out.push(
          horizontal ? (
            <rect key={`${i}-${si}`} x={a} y={pos(i) + off} width={Math.max(0.5, b - a)} height={bw - (groups > 1 ? 1 : 0)} rx={rx} fill={s.color} opacity={dim} />
          ) : (
            <rect key={`${i}-${si}`} x={pos(i) + off} y={b} width={bw - (groups > 1 ? 1 : 0)} height={Math.max(0.5, a - b)} rx={rx} fill={s.color} opacity={dim} />
          ),
        );
      });
    });
    return out;
  };

  const lines = () =>
    series.map((s, si) => {
      const pts = s.values.map((v, i) => {
        if (v === null) return null;
        const below = stacked ? series.slice(0, si).reduce((acc, se) => acc + (se.values[i] ?? 0), 0) : 0;
        return [pos(i), val(v + below), val(below)] as const;
      });
      const segs: string[] = [];
      let d = "";
      pts.forEach((p) => {
        if (!p) {
          if (d) segs.push(d);
          d = "";
          return;
        }
        d += `${d ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      });
      if (d) segs.push(d);
      const valid = pts.filter((p): p is NonNullable<typeof p> => !!p);
      const area =
        (type === "area") && valid.length > 1
          ? `M${valid[0]![0]},${valid[0]![2]}` + valid.map((p) => `L${p[0]},${p[1]}`).join("") + [...valid].reverse().map((p) => `L${p[0]},${p[2]}`).join("") + "Z"
          : null;
      return (
        <g key={si}>
          {area && <path d={area} fill={s.color} opacity={0.16} />}
          {type !== "scatter" && segs.map((sd, k) => <path key={k} d={sd} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {valid.length <= 40 || type === "scatter"
            ? valid.map((p, k) => <circle key={k} cx={p[0]} cy={p[1]} r={type === "scatter" ? 4 : 2.5} fill={type === "scatter" ? s.color : "var(--surface)"} stroke={s.color} strokeWidth={type === "scatter" ? 0 : 1.6} opacity={type === "scatter" ? 0.8 : 1} />)
            : null}
        </g>
      );
    });

  const tip = hover !== null && labels[hover] !== undefined ? { title: labels[hover]!, rows: series.map((s) => ({ name: s.name, color: s.color, value: s.values[hover] ?? null })) } : null;
  return (
    <>
      <svg width={width} height={height} className="block select-none touch-pan-y" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={props.title ?? "图表"}>
        {tk.map((t) => (
          <g key={t}>
            {horizontal ? (
              <>
                <line x1={val(t)} x2={val(t)} y1={pad.t} y2={pad.t + H} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "3 3"} />
                <text x={val(t)} y={height - 6} textAnchor="middle" className="fill-[var(--muted)] text-[11px] tabular-nums">{fmtTick(t)}</text>
              </>
            ) : (
              <>
                <line x1={pad.l} x2={pad.l + W} y1={val(t)} y2={val(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "3 3"} />
                <text x={pad.l - 6} y={val(t) + 3.5} textAnchor="end" className="fill-[var(--muted)] text-[11px] tabular-nums">{fmtTick(t)}</text>
              </>
            )}
          </g>
        ))}
        {hover !== null && type !== "bar" && <line x1={pos(hover)} x2={pos(hover)} y1={pad.t} y2={pad.t + H} stroke="var(--muted)" strokeOpacity={0.4} />}
        {type === "bar" ? bars() : lines()}
        {labels.map((l, i) =>
          i % skip === 0 ? (
            horizontal ? (
              <text key={i} x={pad.l - 6} y={pos(i) + 4} textAnchor="end" className="fill-[var(--muted)] text-[11.5px]">{l.length > 9 ? `${l.slice(0, 8)}…` : l}</text>
            ) : (
              <text key={i} x={pos(i)} y={height - 8} textAnchor="middle" className={cx("text-[11.5px]", hl === i ? "fill-[var(--text)] font-medium" : "fill-[var(--muted)]")}>{fit(l, band * skip - 6)}</text>
            )
          ) : null,
        )}
      </svg>
      {tip && <Tooltip x={horizontal ? pad.l + W / 2 : pos(hover!)} y={horizontal ? pos(hover!) : pad.t} width={width} title={tip.title} rows={tip.rows} format={props.format} unit={props.unit} />}
    </>
  );
}

function Pie({ labels, series, width, height, props, donut }: { labels: string[]; series: Series[]; width: number; height: number; props: ChartProps; donut: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = (series[0]?.values ?? []).map((v) => Math.max(0, v ?? 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const r = Math.min(width, height) / 2 - 6;
  const cx0 = width / 2;
  const cy0 = height / 2;
  const inner = donut ? r * 0.6 : 0;
  let a0 = -Math.PI / 2;
  const arcs = values.map((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const R = hover === i ? r + 4 : r;
    const p = (a: number, rad: number) => `${(cx0 + Math.cos(a) * rad).toFixed(2)},${(cy0 + Math.sin(a) * rad).toFixed(2)}`;
    const full = v / total > 0.9999;
    const d = full
      ? `M${cx0 - R},${cy0}a${R},${R} 0 1,0 ${R * 2},0a${R},${R} 0 1,0 ${-R * 2},0` + (inner ? `M${cx0 - inner},${cy0}a${inner},${inner} 0 1,1 ${inner * 2},0a${inner},${inner} 0 1,1 ${-inner * 2},0` : "")
      : inner
        ? `M${p(a0, R)}A${R},${R} 0 ${big},1 ${p(a1, R)}L${p(a1, inner)}A${inner},${inner} 0 ${big},0 ${p(a0, inner)}Z`
        : `M${cx0},${cy0}L${p(a0, R)}A${R},${R} 0 ${big},1 ${p(a1, R)}Z`;
    const mid = (a0 + a1) / 2;
    a0 = a1;
    return { d, mid, v, i };
  });
  const sel = hover ?? -1;
  return (
    <>
      <svg width={width} height={height} className="block" role="img" aria-label={props.title ?? "图表"}>
        {arcs.map((a) => (
          <path key={a.i} d={a.d} fill={colorOf(props.colors?.[a.i], a.i)} stroke="var(--surface)" strokeWidth={1.5} fillRule="evenodd" opacity={sel >= 0 && sel !== a.i ? 0.55 : 1} onPointerEnter={() => setHover(a.i)} onPointerDown={() => setHover(a.i)} onPointerLeave={() => setHover(null)} />
        ))}
        {donut && (
          <text x={cx0} y={cy0 + 5} textAnchor="middle" className="fill-[var(--text)] text-[15px] font-semibold tabular-nums">
            {sel >= 0 ? `${((values[sel]! / total) * 100).toFixed(1)}%` : formatValue(total, props.format, props.unit, true)}
          </text>
        )}
      </svg>
      {sel >= 0 && (
        <Tooltip x={cx0 + Math.cos(arcs[sel]!.mid) * r * 0.6} y={cy0 + Math.sin(arcs[sel]!.mid) * r * 0.6} width={width} title={labels[sel] ?? ""} rows={[{ name: `${((values[sel]! / total) * 100).toFixed(1)}%`, color: colorOf(props.colors?.[sel], sel), value: values[sel]! }]} format={props.format} unit={props.unit} />
      )}
    </>
  );
}
