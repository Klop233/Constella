import { GENUI_HTML_TAGS, GENUI_SVG_TAGS } from "@constella/protocol";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ArrowDown, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, RotateCcw, Send, X } from "lucide-react";
import { Children, createElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Markdown } from "../Markdown";
import { cx, Select as Dropdown } from "../ui";
import { Chart, formatValue, type ChartProps, type ValueFormat } from "./Chart";
import { ICONS } from "./icons";

// The native components a component block (```ui) can use. They follow docs/design-system.md: theme
// variables only, compact sizes, lines rather than fills. Props arrive from the isolated program
// already resolved (event handlers are functions that call back into it), so every prop is checked
// here as untrusted input: unknown props are ignored, URLs must be http(s), styles can't load things.

export interface Ctx {
  /** Sends a message to the agent as the owner (only works on the owner's own click). */
  send: (text: string) => void;
  copy: (text: string) => void;
  open: (url: string) => void;
}

export interface Node {
  t: string;
  p: Record<string, unknown>;
  c: (Node | string)[];
}

export interface CompProps {
  p: Record<string, any>;
  children: ReactNode;
  kids: (Node | string)[];
  ctx: Ctx;
  render: (n: Node | string, key?: number | string) => ReactNode;
}

const str = (v: unknown, d = ""): string => (v === undefined || v === null ? d : typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const num = (v: unknown, d: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const fn = (v: unknown): ((...a: unknown[]) => void) | undefined => (typeof v === "function" ? (v as (...a: unknown[]) => void) : undefined);
const space = (v: unknown, d: number) => `${Math.max(0, Math.min(num(v, d), 16)) * 4}px`;
const safeUrl = (v: unknown, images = false) => {
  const s = str(v);
  return /^https?:\/\//i.test(s) || (images && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(s)) ? s : "";
};

type Tone = "default" | "muted" | "accent" | "ok" | "warn" | "danger" | "info";
const TONE_TEXT: Record<Tone, string> = { default: "", muted: "text-muted", accent: "text-accent", ok: "text-ok", warn: "text-warn", danger: "text-danger", info: "text-accent" };
const toneVar = (t: unknown) => ({ accent: "var(--color-accent)", info: "var(--color-accent)", ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)", muted: "var(--muted)" })[str(t)] ?? "";
const tone = (t: unknown): Tone => (["muted", "accent", "ok", "warn", "danger", "info"].includes(str(t)) ? (str(t) as Tone) : "default");
const mix = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, transparent)`;

/** Inline markdown in plain strings (**bold**, *em*, `code`, [link](https://…)). */
export function Inline({ text }: { text: string }) {
  const html = useMemo(() => (/[*_`[]/.test(text) ? DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string, { ALLOWED_TAGS: ["strong", "em", "code", "a", "del", "br"], ALLOWED_ATTR: ["href"] }) : null), [text]);
  if (html === null) return <>{text}</>;
  return <span className="[&_code]:font-mono [&_code]:text-[0.88em] [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:rounded-sm [&_a]:text-accent [&_a]:underline" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function IconView({ name, size = 16, className, style }: { name: unknown; size?: number; className?: string; style?: CSSProperties }) {
  const I = ICONS[str(name).toLowerCase()];
  if (!I) return null;
  return <I className={cx("shrink-0", className)} style={{ width: size, height: size, ...style }} strokeWidth={1.8} />;
}

/** A 32px soft tile with an icon, as in item lists and flow nodes. */
function IconTile({ name, toneName, size = 32 }: { name: unknown; toneName?: unknown; size?: number }) {
  const c = toneVar(toneName);
  if (!ICONS[str(name).toLowerCase()]) return null;
  return (
    <span className="grid place-items-center rounded-lg shrink-0" style={{ width: size, height: size, background: c ? mix(c, 12) : "var(--surface-2)", color: c || "var(--muted)" }}>
      <IconView name={name} size={Math.round(size * 0.5)} />
    </span>
  );
}

// ── layout ───────────────────────────────────────────────

const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };
const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", between: "space-between", around: "space-around", evenly: "space-evenly" };
const BG: Record<string, string> = { surface: "var(--surface)", subtle: "var(--surface-2)", muted: "var(--surface-2)", accent: mix("var(--color-accent)", 9), ok: mix("var(--ok)", 10), warn: mix("var(--warn)", 10), danger: mix("var(--danger)", 9) };

function boxStyle(p: Record<string, any>, dir: "row" | "column", defGap: number): CSSProperties {
  return {
    display: "flex",
    flexDirection: dir,
    flexWrap: dir === "row" && p.wrap !== false ? "wrap" : undefined,
    gap: space(p.gap, defGap),
    alignItems: ALIGN[str(p.align)] ?? (dir === "row" ? "center" : undefined),
    justifyContent: JUSTIFY[str(p.justify)],
    padding: p.padding !== undefined ? space(p.padding, 0) : undefined,
    background: BG[str(p.background ?? p.bg)],
    border: p.border ? "1px solid var(--border)" : undefined,
    borderRadius: p.border || p.background || p.bg ? 8 : undefined,
    flex: p.flex !== undefined ? `${num(p.flex, 1)} 1 0%` : undefined,
    minWidth: 0,
    textAlign: ["left", "center", "right"].includes(str(p.textAlign)) ? (str(p.textAlign) as "left") : undefined,
  };
}

const Box = ({ p, children }: CompProps) => <div style={boxStyle(p, str(p.direction) === "row" ? "row" : "column", 2)}>{children}</div>;
const Row = ({ p, children }: CompProps) => <div style={boxStyle(p, "row", 2)}>{children}</div>;
const Col = ({ p, children }: CompProps) => <div style={boxStyle(p, "column", 3)}>{children}</div>;

function Grid({ p, children }: CompProps) {
  // Up to `cols` columns, each at least `min` px wide, so a row of stats stays two-up on a phone.
  const cols = Math.max(0, Math.min(num(p.cols ?? p.columns, 0), 6));
  const min = num(p.min ?? p.minWidth, cols ? 140 : 160);
  const gap = space(p.gap, 3);
  const track = cols ? `minmax(max(${min}px, calc((100% - ${cols - 1} * ${gap}) / ${cols})), 1fr)` : `minmax(min(${min}px, 100%), 1fr)`;
  return (
    <div className="grid min-w-0" style={{ gap, gridTemplateColumns: `repeat(auto-fit, ${track})` }}>
      {children}
    </div>
  );
}

function Card({ p, children, ctx }: CompProps) {
  const t = tone(p.tone);
  const click = fn(p.onClick);
  const selected = !!p.selected;
  const body = (
    <>
      {(p.title || p.icon || p.badge) && (
        <div className="flex items-center gap-2 min-w-0">
          {p.icon && <IconView name={p.icon} size={16} className={TONE_TEXT[t] || "text-muted"} />}
          {p.title && <div className="flex-1 min-w-0 font-semibold text-[14px] leading-snug"><Inline text={str(p.title)} /></div>}
          {p.badge && <Badge p={{ tone: p.badgeTone ?? "accent" }} children={str(p.badge)} kids={[]} ctx={ctx} render={() => null} />}
        </div>
      )}
      {p.subtitle && <div className="text-xs text-muted -mt-1"><Inline text={str(p.subtitle)} /></div>}
      {children}
    </>
  );
  const cls = cx(
    "min-w-0 flex flex-col gap-2.5 rounded-xl border bg-surface p-3.5 text-left",
    selected ? "border-[color-mix(in_oklab,var(--color-accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_5%,var(--surface))]" : "border-line",
    click && "transition-colors hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] cursor-pointer",
  );
  const style: CSSProperties = t !== "default" && !selected ? { borderColor: mix(toneVar(t), 40) } : {};
  return click ? (
    <button type="button" className={cls} style={style} onClick={() => click()}>
      {body}
    </button>
  ) : (
    <div className={cls} style={style}>
      {body}
    </div>
  );
}

const Divider = ({ p }: CompProps) =>
  p.label ? (
    <div className="flex items-center gap-3 text-xs text-muted my-1">
      <div className="h-px flex-1 bg-[var(--border)]" />
      {str(p.label)}
      <div className="h-px flex-1 bg-[var(--border)]" />
    </div>
  ) : (
    <div className="h-px bg-[var(--border)] my-1" />
  );
const Spacer = ({ p }: CompProps) => <div style={{ flex: p.size === undefined ? 1 : undefined, height: p.size !== undefined ? space(p.size, 2) : undefined }} />;

/** A small two-sided label row above a block (ChatGPT's "流式渲染示意 … 逐步构造组件树"). */
const Caption = ({ p, children }: CompProps) => (
  <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
    <span className="font-medium">{p.left !== undefined ? <Inline text={str(p.left)} /> : children}</span>
    {p.right !== undefined && <span className="text-right"><Inline text={str(p.right)} /></span>}
  </div>
);

/** A placeholder for something that hasn't been generated yet: fixed height, so the reply doesn't jump. */
function Loading({ p }: CompProps) {
  const rows = Math.max(1, Math.min(num(p.rows, 3), 8));
  const widths = [92, 74, 55, 84, 63, 88, 70, 46];
  return (
    <div className="min-w-0 space-y-2.5" aria-busy="true" aria-label={str(p.label, "正在生成")}>
      {p.label !== undefined && <div className="text-[13px] text-muted"><Inline text={str(p.label)} /></div>}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-2.5 rounded-full bg-surface-2 pulse-dot" style={{ width: `${widths[i % widths.length]}%` }} />
      ))}
      {p.height !== undefined && <div className="rounded-lg bg-surface-2 pulse-dot" style={{ height: Math.max(24, Math.min(num(p.height, 96), 400)) }} />}
    </div>
  );
}

// ── text ─────────────────────────────────────────────────

const SIZES: Record<string, string> = { xs: "text-xs", sm: "text-[13px]", md: "text-sm", lg: "text-[15px]", xl: "text-lg", "2xl": "text-2xl", "3xl": "text-3xl" };

function Text({ p, children }: CompProps) {
  const t = tone(p.tone ?? p.color);
  return (
    <p
      className={cx(
        "leading-relaxed min-w-0",
        SIZES[str(p.size)] ?? "text-sm",
        TONE_TEXT[t],
        (p.bold || p.weight === "bold" || p.weight === "semibold") && "font-semibold",
        p.weight === "medium" && "font-medium",
        p.italic && "italic",
        p.mono && "font-mono",
        p.truncate && "truncate",
        ["2xl", "3xl", "xl"].includes(str(p.size)) && "font-display tabular-nums leading-tight",
        str(p.align) === "center" && "text-center",
        str(p.align) === "right" && "text-right",
      )}
    >
      {children}
    </p>
  );
}

function Heading({ p, children }: CompProps) {
  const level = Math.max(1, Math.min(4, num(p.level, 3)));
  const cls = ["", "text-xl", "text-[17px]", "text-[15px]", "text-sm"][level];
  return createElement(`h${level + 1}`, { className: cx("font-display font-semibold leading-snug", cls) }, children);
}

const MarkdownC = ({ p, kids }: CompProps) => <Markdown text={str(p.text ?? p.content, kids.filter((k) => typeof k === "string").join(""))} className="font-display text-sm" />;

function Code({ p, kids, ctx }: CompProps) {
  const code = str(p.code, kids.filter((k) => typeof k === "string").join(""));
  return (
    <div className="relative group/code rounded-lg border border-line bg-surface-2">
      {p.lang && <div className="px-3 pt-2 text-[11px] text-muted font-mono">{str(p.lang)}</div>}
      <button type="button" aria-label="复制" onClick={() => ctx.copy(code)} className="absolute right-1.5 top-1.5 size-6 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface opacity-0 group-hover/code:opacity-100 pointer-coarse:opacity-100">
        <Copy className="size-3.5" strokeWidth={1.8} />
      </button>
      <pre className="px-3 py-2 overflow-x-auto font-mono text-[12.5px] leading-5">{code}</pre>
    </div>
  );
}

const Icon = ({ p }: CompProps) => <IconView name={p.name} size={num(p.size, 16)} className={TONE_TEXT[tone(p.tone)] || undefined} />;

function Badge({ p, children }: CompProps) {
  const c = toneVar(p.tone) || "var(--muted)";
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 text-[11.5px] leading-[18px] whitespace-nowrap self-start" style={{ background: mix(c, 13), color: c }}>
      {p.icon && <IconView name={p.icon} size={12} />}
      {children}
    </span>
  );
}
const Kbd = ({ children }: CompProps) => <kbd className="font-mono text-[11.5px] rounded border border-line bg-surface-2 px-1">{children}</kbd>;

// ── data ─────────────────────────────────────────────────

function Stat({ p }: CompProps) {
  const d = p.delta;
  const dn = typeof d === "number" ? d : Number.parseFloat(str(d));
  const up = Number.isFinite(dn) ? dn >= 0 : null;
  const good = p.invert ? !up : up;
  return (
    <div className="min-w-0 flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {p.icon && <IconView name={p.icon} size={13} />}
        <span className="truncate">{str(p.label)}</span>
      </div>
      <div className={cx("font-display text-[22px] font-semibold leading-tight tabular-nums break-all", TONE_TEXT[tone(p.tone)])}>{str(p.value, "—")}</div>
      {(p.sub || d !== undefined) && (
        <div className="text-xs text-muted flex items-center gap-1.5 flex-wrap">
          {d !== undefined && <span className={cx("tabular-nums font-medium", good === null ? "" : good ? "text-ok" : "text-danger")}>{typeof d === "number" ? `${d >= 0 ? "+" : ""}${d}` : str(d)}</span>}
          {p.sub && <Inline text={str(p.sub)} />}
        </div>
      )}
    </div>
  );
}

function Progress({ p }: CompProps) {
  const max = num(p.max, 100) || 100;
  const v = Math.max(0, Math.min(num(p.value, 0), max));
  const c = toneVar(p.tone) || "var(--color-accent)";
  return (
    <div className="min-w-0 space-y-1">
      {(p.label || p.showValue !== false) && (
        <div className="flex justify-between gap-2 text-[13px]">
          <span className="text-muted truncate">{str(p.label)}</span>
          {p.showValue !== false && <span className="tabular-nums">{p.valueLabel !== undefined ? str(p.valueLabel) : `${Math.round((v / max) * 100)}%`}</span>}
        </div>
      )}
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: mix("var(--text)", 12) }}>
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${(v / max) * 100}%`, background: c }} />
      </div>
    </div>
  );
}

function Table({ p, render }: CompProps) {
  type Col = { key: string; label: string; align?: string; format?: ValueFormat; unit?: string };
  const rawCols: unknown[] = Array.isArray(p.columns) ? p.columns : [];
  const rows: unknown[] = Array.isArray(p.rows) ? p.rows : Array.isArray(p.data) ? p.data : [];
  const first = rows[0];
  const cols: Col[] = rawCols.length
    ? rawCols.map((c, i) => (c && typeof c === "object" ? { key: str((c as any).key, String(i)), label: str((c as any).label ?? (c as any).key), align: str((c as any).align), format: (c as any).format, unit: str((c as any).unit) } : { key: String(i), label: str(c) }))
    : first && typeof first === "object" && !Array.isArray(first)
      ? Object.keys(first).map((k) => ({ key: k, label: k }))
      : [];
  const cell = (row: unknown, c: Col, i: number): unknown => (Array.isArray(row) ? row[i] : row && typeof row === "object" ? (row as any)[c.key] ?? (rawCols.length && !(rawCols[0] && typeof rawCols[0] === "object") ? (row as any)[c.label] : undefined) : undefined);
  const numeric = cols.map((c, i) => c.align === "right" || (c.align !== "left" && rows.length > 0 && rows.every((r) => { const v = cell(r, c, i); return typeof v === "number" || (typeof v === "string" && /^[-+¥$]?[\d,.]+\s*(%|万|亿|元|k|K|M|ms|s|GB|MB)?$/.test(v.trim())); })));
  const hl = num(p.highlight, -1);
  return (
    <div className="min-w-0 overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-[13px] tabular-nums border-collapse">
        <thead>
          <tr className="bg-surface-2">
            {cols.map((c, i) => (
              <th key={i} className={cx("px-3 py-2 font-medium text-muted text-[12.5px] whitespace-nowrap", numeric[i] ? "text-right" : "text-left")}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className={cx("border-t border-line", ri === hl && "bg-[color-mix(in_oklab,var(--color-accent)_7%,transparent)] font-medium")}>
              {cols.map((c, i) => {
                const v = cell(r, c, i);
                const content = v && typeof v === "object" && "$node" in (v as object) ? render((v as any).$node) : typeof v === "number" && c.format ? formatValue(v, c.format, c.unit) : typeof v === "number" ? v.toLocaleString("zh-CN") : <Inline text={str(v)} />;
                return (
                  <td key={i} className={cx("px-3 py-2 align-top", numeric[i] ? "text-right whitespace-nowrap" : "text-left")}>
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ChartC = ({ p }: CompProps) => <Chart {...(p as ChartProps)} />;

function KeyValue({ p }: CompProps) {
  const items: { label: string; value: string }[] = Array.isArray(p.items)
    ? p.items.map((it: any) => ({ label: str(it?.label ?? it?.[0]), value: str(it?.value ?? it?.[1]) }))
    : p.items && typeof p.items === "object"
      ? Object.entries(p.items).map(([k, v]) => ({ label: k, value: str(v) }))
      : [];
  return (
    <dl className="min-w-0 divide-y divide-[var(--border)] text-[13px]">
      {items.map((it, i) => (
        <div key={i} className="flex justify-between gap-4 py-1.5">
          <dt className="text-muted">{it.label}</dt>
          <dd className="text-right tabular-nums font-medium"><Inline text={it.value} /></dd>
        </div>
      ))}
    </dl>
  );
}

function List({ p, children, kids }: CompProps) {
  const items: unknown[] = Array.isArray(p.items) ? p.items : [];
  const ordered = !!p.ordered;
  if (!items.length && kids.some((k) => typeof k !== "string" && k.t === "Item")) {
    return <div className={cx("min-w-0 flex flex-col", p.divided === false ? "gap-3" : "divide-y divide-[var(--border)]")}>{children}</div>;
  }
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={cx("min-w-0 text-sm leading-relaxed pl-5 space-y-1", ordered ? "list-decimal" : "list-disc")}>
      {items.length ? items.map((it, i) => <li key={i}><Inline text={str(it)} /></li>) : children}
    </Tag>
  );
}

/** A row with an icon tile, a bold title and a description (ChatGPT's 本地交互 / Agent 交互 list). */
function Item({ p, children, ctx }: CompProps) {
  const click = fn(p.onClick);
  const sendText = str(p.send);
  const inner = (
    <>
      {p.icon && <IconTile name={p.icon} toneName={p.tone} size={num(p.iconSize, 32)} />}
      <div className="flex-1 min-w-0 space-y-0.5">
        {p.title && <div className="text-sm font-semibold leading-snug"><Inline text={str(p.title)} /></div>}
        {p.desc && <div className="text-[13px] text-muted leading-relaxed"><Inline text={str(p.desc)} /></div>}
        {children && <div className="text-[13.5px] leading-relaxed space-y-1">{children}</div>}
      </div>
      {p.right !== undefined && <div className="shrink-0 text-[13px] text-muted tabular-nums self-center">{str(p.right)}</div>}
      {(click || sendText) && <ChevronRight className="size-4 text-muted self-center shrink-0" strokeWidth={1.8} />}
    </>
  );
  const cls = "flex items-start gap-3 py-2.5 first:pt-0 last:pb-0 min-w-0 text-left w-full";
  return click || sendText ? (
    <button type="button" className={cx(cls, "rounded-md hover:bg-[color-mix(in_oklab,var(--text)_4%,transparent)]")} onClick={() => (click ? click() : ctx.send(sendText))}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** Boxes joined by arrows: architecture, pipelines, processes. Vertical unless `direction="horizontal"` (which stacks on phones). */
function Flow({ p, kids, render }: CompProps) {
  const nodes = kids.filter((k): k is Node => typeof k !== "string");
  const horizontal = str(p.direction) === "horizontal" || str(p.direction) === "row";
  return (
    <div className={cx("min-w-0 flex gap-1.5", horizontal ? "flex-col sm:flex-row sm:items-stretch" : "flex-col items-stretch")}>
      {nodes.map((n, i) => (
        <div key={i} className={cx("contents")}>
          {i > 0 && (
            <div className={cx("grid place-items-center text-muted shrink-0", horizontal ? "sm:w-5 h-5 sm:h-auto" : "h-5")}>
              {horizontal ? (
                <>
                  <ArrowDown className="size-3.5 sm:hidden" strokeWidth={1.8} />
                  <ArrowRight className="size-3.5 hidden sm:block" strokeWidth={1.8} />
                </>
              ) : (
                <ArrowDown className="size-3.5" strokeWidth={1.8} />
              )}
            </div>
          )}
          {n.t === "Node" ? <FlowNode p={n.p as Record<string, any>} kids={n.c} render={render} horizontal={horizontal} /> : render(n, i)}
        </div>
      ))}
    </div>
  );
}

function FlowNode({ p, kids, render, horizontal }: { p: Record<string, any>; kids: (Node | string)[]; render: CompProps["render"]; horizontal: boolean }) {
  const c = toneVar(p.tone);
  const items: unknown[] = Array.isArray(p.items) ? p.items : [];
  return (
    <div
      className={cx("min-w-0 rounded-xl px-3 py-2.5 flex flex-col items-center text-center gap-1", horizontal && "sm:flex-1")}
      style={{ background: c ? mix(c, 9) : "var(--surface-2)", border: p.highlight ? `1px solid ${mix(c || "var(--color-accent)", 50)}` : "1px solid transparent" }}
    >
      {p.icon && <IconView name={p.icon} size={18} style={{ color: c || "var(--muted)" }} />}
      {p.title && <div className="text-sm font-semibold leading-snug"><Inline text={str(p.title)} /></div>}
      {p.desc && <div className="text-xs text-muted leading-relaxed"><Inline text={str(p.desc)} /></div>}
      {items.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5 mt-1">
          {items.map((it, i) => (
            <span key={i} className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs">{str(it)}</span>
          ))}
        </div>
      )}
      {kids.length > 0 && <div className="w-full text-[13px]">{kids.map((k, i) => render(k, i))}</div>}
    </div>
  );
}

function Timeline({ p, kids, render }: CompProps) {
  const fromItems = Array.isArray(p.items) ? (p.items as any[]).map((it) => ({ p: it ?? {}, c: [] as (Node | string)[] })) : [];
  const events = fromItems.length ? fromItems : kids.filter((k): k is Node => typeof k !== "string" && k.t === "Event").map((k) => ({ p: k.p as Record<string, any>, c: k.c }));
  return (
    <ol className="min-w-0 relative space-y-3.5 pl-5 before:absolute before:left-[5px] before:top-1.5 before:bottom-1.5 before:w-px before:bg-[var(--border)]">
      {events.map((e, i) => {
        const c = toneVar(e.p.tone) || (e.p.active ? "var(--color-accent)" : "");
        return (
          <li key={i} className="relative">
            <span className="absolute -left-5 top-1.5 size-[11px] rounded-full border-2 bg-surface" style={{ borderColor: c || "var(--border)", background: e.p.done || e.p.active ? c || "var(--muted)" : undefined }} />
            {e.p.time !== undefined && <div className="text-xs text-muted tabular-nums">{str(e.p.time)}</div>}
            {e.p.title && <div className="text-sm font-semibold leading-snug"><Inline text={str(e.p.title)} /></div>}
            {e.p.desc && <div className="text-[13px] text-muted leading-relaxed"><Inline text={str(e.p.desc)} /></div>}
            {e.c.length > 0 && <div className="mt-1 text-[13.5px] space-y-1">{e.c.map((k, j) => render(k, j))}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// ── interactive containers (state lives here, not in the program) ──

function Steps({ p, kids, render }: CompProps) {
  const steps = kids.filter((k): k is Node => typeof k !== "string" && k.t === "Step");
  const [cur, setCur] = useState(() => Math.max(0, Math.min(num(p.initial, 0), steps.length - 1)));
  const i = Math.min(cur, Math.max(0, steps.length - 1));
  const step = steps[i];
  if (!steps.length) return null;
  const numbers = str(p.variant) !== "dots";
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <div className="flex-1 min-w-0 font-semibold text-[14px] truncate">{str(step?.p.title ?? p.title)}</div>
        <div className="flex items-center gap-0.5 shrink-0">
          {steps.map((_, k) =>
            numbers ? (
              <button key={k} type="button" onClick={() => setCur(k)} className={cx("size-7 rounded-md text-[13px] tabular-nums", k === i ? "bg-surface-2 font-semibold" : "text-muted hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]")}>
                {k + 1}
              </button>
            ) : (
              <button key={k} type="button" aria-label={`第 ${k + 1} 步`} onClick={() => setCur(k)} className="p-1">
                <span className={cx("block size-1.5 rounded-full", k === i ? "bg-[var(--text)]" : "bg-[color-mix(in_oklab,var(--text)_25%,transparent)]")} />
              </button>
            ),
          )}
        </div>
      </div>
      <div className="px-3.5 pb-3 pt-2 space-y-2.5 min-w-0">
        {step?.p.desc ? <div className="text-[13px] text-muted"><Inline text={str(step.p.desc)} /></div> : null}
        {step?.c.map((k, j) => render(k, j))}
      </div>
      {steps.length > 1 && (
        <div className="flex items-center justify-between px-2 py-1.5 border-t border-line text-[13px]">
          <button type="button" disabled={i === 0} onClick={() => setCur(i - 1)} className="h-7 px-2 rounded-md inline-flex items-center gap-1 text-muted hover:text-[var(--text)] disabled:opacity-40">
            <ChevronLeft className="size-3.5" strokeWidth={1.8} />上一步
          </button>
          <span className="text-xs text-muted tabular-nums">{i + 1} / {steps.length}</span>
          <button type="button" disabled={i === steps.length - 1} onClick={() => setCur(i + 1)} className="h-7 px-2 rounded-md inline-flex items-center gap-1 text-muted hover:text-[var(--text)] disabled:opacity-40">
            下一步<ChevronRight className="size-3.5" strokeWidth={1.8} />
          </button>
        </div>
      )}
    </div>
  );
}

function Tabs({ p, kids, render }: CompProps) {
  const tabs = kids.filter((k): k is Node => typeof k !== "string" && k.t === "Tab");
  const [cur, setCur] = useState(() => {
    if (p.defaultValue === undefined) return 0;
    const i = tabs.findIndex((t, k) => [str(t.p.value, String(k)), str(t.p.label ?? t.p.title)].includes(str(p.defaultValue)));
    return Math.max(0, i);
  });
  const onChange = fn(p.onChange);
  const controlled = p.value !== undefined ? Math.max(0, tabs.findIndex((t, i) => str(t.p.value, String(i)) === str(p.value))) : null;
  const i = Math.min(controlled ?? cur, Math.max(0, tabs.length - 1));
  if (!tabs.length) return null;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex gap-0.5 p-0.5 rounded-md bg-surface-2 w-max max-w-full overflow-x-auto no-scrollbar">
        {tabs.map((t, k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setCur(k);
              onChange?.(str(t.p.value, String(k)));
            }}
            className={cx("h-6 px-2.5 rounded text-[12.5px] whitespace-nowrap inline-flex items-center gap-1.5 border", k === i ? "bg-surface border-line" : "border-transparent text-muted hover:text-[var(--text)]")}
          >
            {t.p.icon ? <IconView name={t.p.icon} size={13} /> : null}
            {str(t.p.label ?? t.p.title, `选项 ${k + 1}`)}
          </button>
        ))}
      </div>
      <div className="min-w-0 space-y-3">{tabs[i]?.c.map((k, j) => render(k, j))}</div>
    </div>
  );
}

function Accordion({ p, kids, render, children }: CompProps) {
  const items = kids.filter((k): k is Node => typeof k !== "string" && k.t === "Details");
  if (!items.length) return <div className="min-w-0">{children}</div>;
  return <div className="min-w-0 rounded-xl border border-line divide-y divide-[var(--border)]">{items.map((it, i) => <DetailsView key={i} p={it.p as Record<string, any>} kids={it.c} render={render} flat open={i === num(p.open, -1)} />)}</div>;
}

function DetailsView({ p, kids, render, flat, open: initial }: { p: Record<string, any>; kids: (Node | string)[]; render: CompProps["render"]; flat?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(!!(initial || p.open));
  return (
    <div className={cx("min-w-0", !flat && "rounded-xl border border-line")}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left">
        {p.icon && <IconView name={p.icon} size={15} className="text-muted" />}
        <span className="flex-1 min-w-0 text-sm font-medium"><Inline text={str(p.summary ?? p.title)} /></span>
        <ChevronDown className={cx("size-4 text-muted transition-transform", open && "rotate-180")} strokeWidth={1.8} />
      </button>
      {open && <div className="px-3.5 pb-3 space-y-2 text-[13.5px] leading-relaxed min-w-0">{kids.map((k, i) => render(k, i))}</div>}
    </div>
  );
}
const Details = ({ p, kids, render }: CompProps) => <DetailsView p={p} kids={kids} render={render} />;

function Callout({ p, children }: CompProps) {
  const t = str(p.tone) === "tip" ? "accent" : tone(p.tone) === "default" ? "info" : tone(p.tone);
  const c = toneVar(t) || "var(--color-accent)";
  const icons: Record<string, string> = { info: "info", accent: "lightbulb", ok: "check-circle", warn: "alert", danger: "x-circle", muted: "info" };
  const icon = p.icon ?? icons[t] ?? "info";
  return (
    <div className="min-w-0 flex gap-2.5 rounded-xl px-3.5 py-2.5" style={{ background: mix(c, 8), border: `1px solid ${mix(c, 25)}` }}>
      <IconView name={icon} size={16} className="mt-0.5" style={{ color: c }} />
      <div className="flex-1 min-w-0 space-y-1 text-[13.5px] leading-relaxed">
        {p.title && <div className="font-semibold"><Inline text={str(p.title)} /></div>}
        {children}
      </div>
    </div>
  );
}

function Quiz({ p, ctx }: CompProps) {
  const qs: { q: string; options: string[]; answer: number; explain: string }[] = (Array.isArray(p.questions) ? p.questions : [])
    .map((q: any) => ({ q: str(q?.question ?? q?.q), options: (Array.isArray(q?.options) ? q.options : []).map((o: unknown) => str(o)), answer: num(q?.answer, 0), explain: str(q?.explain ?? q?.explanation) }))
    .filter((q: { q: string; options: string[] }) => q.q && q.options.length >= 2);
  const [picked, setPicked] = useState<(number | null)[]>(() => qs.map(() => null));
  const [i, setI] = useState(0);
  if (!qs.length) return null;
  const done = picked.every((x) => x !== null) && picked.length === qs.length;
  const score = picked.filter((x, k) => x === qs[k]!.answer).length;
  const q = qs[Math.min(i, qs.length - 1)]!;
  const mine = picked[i] ?? null;
  const pick = (o: number) => {
    if (mine !== null) return;
    const next = picked.slice();
    next[i] = o;
    setPicked(next);
  };
  const reset = () => {
    setPicked(qs.map(() => null));
    setI(0);
  };
  const wrong = qs.map((x, k) => ({ x, k })).filter(({ x, k }) => picked[k] !== null && picked[k] !== x.answer);
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="text-xs text-muted tabular-nums">{str(p.title, "小测验")} · 第 {Math.min(i, qs.length - 1) + 1} / {qs.length} 题</span>
        <span className="flex-1" />
        <div className="flex gap-1">
          {qs.map((x, k) => (
            <button key={k} type="button" aria-label={`第 ${k + 1} 题`} onClick={() => setI(k)} className="p-0.5">
              <span className="block size-2 rounded-full" style={{ background: picked[k] === null ? (k === i ? "var(--text)" : mix("var(--text)", 20)) : picked[k] === x.answer ? "var(--ok)" : "var(--danger)" }} />
            </button>
          ))}
        </div>
      </div>
      <div className="px-3.5 py-3 space-y-2.5">
        <div className="text-sm font-semibold leading-snug"><Inline text={q.q} /></div>
        <div className="space-y-1.5">
          {q.options.map((o, k) => {
            const state = mine === null ? "idle" : k === q.answer ? "right" : k === mine ? "wrong" : "rest";
            return (
              <button
                key={k}
                type="button"
                onClick={() => pick(k)}
                disabled={mine !== null}
                className={cx(
                  "w-full flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13.5px] transition-colors",
                  state === "idle" && "border-line hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)]",
                  state === "right" && "border-[color-mix(in_oklab,var(--ok)_55%,transparent)] bg-[color-mix(in_oklab,var(--ok)_8%,transparent)]",
                  state === "wrong" && "border-[color-mix(in_oklab,var(--danger)_55%,transparent)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)]",
                  state === "rest" && "border-line opacity-60",
                )}
              >
                <span className="size-5 shrink-0 grid place-items-center rounded-full border border-line text-[11px] text-muted">{state === "right" ? <Check className="size-3 text-ok" /> : state === "wrong" ? <X className="size-3 text-danger" /> : String.fromCharCode(65 + k)}</span>
                <span className="flex-1"><Inline text={o} /></span>
              </button>
            );
          })}
        </div>
        {mine !== null && q.explain && <div className="text-[13px] text-muted leading-relaxed"><Inline text={q.explain} /></div>}
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2 border-t border-line text-[13px]">
        {done ? (
          <>
            <span className="font-semibold tabular-nums">得分 {score} / {qs.length}</span>
            <span className="flex-1" />
            <button type="button" onClick={reset} className="h-7 px-2 rounded-md inline-flex items-center gap-1 text-muted hover:text-[var(--text)]">
              <RotateCcw className="size-3.5" strokeWidth={1.8} />重做
            </button>
            {wrong.length > 0 && (
              <button
                type="button"
                onClick={() => ctx.send(`小测验我答错了这些题，请再讲讲：\n${wrong.map(({ x, k }) => `${k + 1}. ${x.q}（我选了「${x.options[picked[k]!]}」，正确是「${x.options[x.answer]}」）`).join("\n")}`)}
                className="h-7 px-2.5 rounded-md inline-flex items-center gap-1 bg-accent text-white font-medium"
              >
                讲解错题
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" disabled={i === 0} onClick={() => setI(i - 1)} className="h-7 px-2 rounded-md text-muted hover:text-[var(--text)] disabled:opacity-40">上一题</button>
            <span className="flex-1" />
            <button type="button" disabled={i >= qs.length - 1} onClick={() => setI(i + 1)} className="h-7 px-2 rounded-md text-muted hover:text-[var(--text)] disabled:opacity-40">下一题</button>
          </>
        )}
      </div>
    </div>
  );
}

function ImageC({ p }: CompProps) {
  const src = safeUrl(p.src, true);
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <figure className="min-w-0 space-y-1">
      <img src={src} alt={str(p.alt)} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cx("rounded-xl border border-line w-full bg-surface-2", p.fit === "contain" ? "object-contain" : "object-cover")} style={{ aspectRatio: str(p.ratio ?? p.aspectRatio).replace(":", "/") || undefined, maxHeight: num(p.height, 420) }} />
      {p.caption && <figcaption className="text-xs text-muted text-center"><Inline text={str(p.caption)} /></figcaption>}
    </figure>
  );
}

function Suggestions({ p, ctx }: CompProps) {
  const items: { label: string; text: string }[] = (Array.isArray(p.items) ? p.items : []).map((it: any) => (typeof it === "string" ? { label: it, text: it } : { label: str(it?.label ?? it?.text), text: str(it?.text ?? it?.label) })).filter((x: { label: string }) => x.label);
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <button key={i} type="button" onClick={() => ctx.send(it.text)} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line bg-surface text-[13px] hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] hover:bg-surface-2">
          <Send className="size-3 text-muted" strokeWidth={1.8} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ── inputs: controlled by the program when it passes value + onChange, otherwise local ──

/** Local value that follows the program's value, except while the owner is changing it. */
function useControlled<T>(value: T | undefined, fallback: T): [T, (v: T) => void, () => void] {
  const [local, setLocal] = useState<T>(value ?? fallback);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current && value !== undefined) setLocal(value);
  }, [value]);
  return [
    local,
    (v: T) => {
      editing.current = true;
      setLocal(v);
    },
    () => {
      editing.current = false;
    },
  ];
}

const labelCls = "flex flex-col gap-1.5 min-w-0";
const fieldCls = "h-8 px-2.5 rounded-lg border border-line bg-surface text-[13.5px] outline-none hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] focus:border-accent w-full min-w-0";

/** A form: its fields plus one submit button. What it sends is gathered from the fields as they are now. */
function Form({ p, children }: CompProps) {
  const submit = fn(p.onSubmit);
  const label = str(p.submitLabel, "提交");
  return (
    <div className="min-w-0 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3.5" style={{ textAlign: ["left", "center", "right"].includes(str(p.textAlign)) ? (str(p.textAlign) as "left") : undefined }}>
      {p.title !== undefined && <div className="font-semibold text-[14px] leading-snug"><Inline text={str(p.title)} /></div>}
      {children}
      {submit && (
        <button type="button" onClick={() => submit()} className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent text-white text-[13.5px] font-medium hover:brightness-105">
          <Send className="size-3.5" strokeWidth={1.8} />
          {label}
        </button>
      )}
    </div>
  );
}

function Slider({ p }: CompProps) {
  const min = num(p.min, 0);
  const max = num(p.max, 100);
  const step = num(p.step, (max - min) / 100 > 1 ? 1 : (max - min) / 100);
  const [v, setV, done] = useControlled<number>(p.value === undefined ? undefined : num(p.value, min), num(p.defaultValue, min));
  const onChange = fn(p.onChange);
  const raf = useRef(0);
  const shown = p.display !== undefined ? str(p.display) : p.format ? formatValue(v, p.format as ValueFormat, str(p.unit)) : `${Number(v.toFixed(6)).toLocaleString("zh-CN")}${str(p.unit)}`;
  const pct = ((v - min) / (max - min || 1)) * 100;
  return (
    <label className={labelCls}>
      <span className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted">{str(p.label)}</span>
        <span className="font-semibold tabular-nums text-[var(--text)]">{shown}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        aria-label={str(p.label)}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          cancelAnimationFrame(raf.current);
          raf.current = requestAnimationFrame(() => onChange?.(n));
        }}
        onPointerUp={done}
        onKeyUp={done}
        onBlur={done}
        className="genui-range w-full"
        style={{ "--pct": `${pct}%` } as CSSProperties}
      />
      {(p.minLabel !== undefined || p.maxLabel !== undefined || p.showRange) && (
        <span className="flex justify-between text-[11px] text-muted tabular-nums -mt-0.5">
          <span>{str(p.minLabel, p.format ? formatValue(min, p.format, str(p.unit)) : `${min}${str(p.unit)}`)}</span>
          <span>{str(p.maxLabel, p.format ? formatValue(max, p.format, str(p.unit)) : `${max}${str(p.unit)}`)}</span>
        </span>
      )}
    </label>
  );
}

function NumberInput({ p }: CompProps) {
  const [v, setV, done] = useControlled<string>(p.value === undefined ? undefined : str(p.value), str(p.defaultValue));
  const onChange = fn(p.onChange);
  return (
    <label className={labelCls}>
      {p.label && <span className="text-[13px] text-muted">{str(p.label)}</span>}
      <span className="relative flex items-center">
        <input
          type="number"
          inputMode="decimal"
          value={v}
          min={p.min as number | undefined}
          max={p.max as number | undefined}
          step={p.step as number | undefined}
          placeholder={str(p.placeholder)}
          onChange={(e) => {
            setV(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n)) onChange?.(n);
          }}
          onBlur={done}
          className={cx(fieldCls, "tabular-nums", p.unit && "pr-9")}
        />
        {p.unit && <span className="absolute right-2.5 text-xs text-muted pointer-events-none">{str(p.unit)}</span>}
      </span>
    </label>
  );
}

function TextInput({ p, area }: { p: Record<string, any>; area?: boolean }) {
  const [v, setV, done] = useControlled<string>(p.value === undefined ? undefined : str(p.value), str(p.defaultValue));
  const onChange = fn(p.onChange);
  const onSubmit = fn(p.onSubmit);
  const common = {
    value: v,
    placeholder: str(p.placeholder),
    onBlur: done,
    onChange: (e: { target: { value: string } }) => {
      setV(e.target.value);
      onChange?.(e.target.value);
    },
  };
  return (
    <label className={labelCls}>
      {p.label && <span className="text-[13px] text-muted">{str(p.label)}</span>}
      {area ? (
        <textarea {...common} rows={num(p.rows, 3)} className={cx(fieldCls, "h-auto py-2 resize-y leading-relaxed")} />
      ) : (
        <input {...common} type="text" onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && onSubmit?.(v)} className={fieldCls} />
      )}
    </label>
  );
}

/** An option: `value` is its string key for the DOM, `raw` what the program gave (handed back as is, numbers stay numbers). */
type Opt = { value: string; raw: unknown; label: string; desc?: string; icon?: unknown; badge?: string };
const opts = (v: unknown): Opt[] =>
  (Array.isArray(v) ? v : []).map((o: any) =>
    o && typeof o === "object"
      ? { value: str(o.value ?? o.label), raw: o.value ?? o.label, label: str(o.label ?? o.value), desc: o.desc !== undefined ? str(o.desc) : undefined, icon: o.icon, badge: o.badge !== undefined ? str(o.badge) : undefined }
      : { value: str(o), raw: o, label: str(o) },
  );
const rawOf = (options: Opt[], value: string) => options.find((o) => o.value === value)?.raw ?? value;

function Select({ p }: CompProps) {
  const options = opts(p.options);
  const [v, setV, done] = useControlled<string>(p.value === undefined ? undefined : str(p.value), str(p.defaultValue, options[0]?.value ?? ""));
  const onChange = fn(p.onChange);
  return (
    <label className={labelCls}>
      {p.label && <span className="text-[13px] text-muted">{str(p.label)}</span>}
      <Dropdown
        className="w-full"
        value={v}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
        onChange={(x) => {
          setV(x);
          done();
          onChange?.(rawOf(options, x));
        }}
      />
    </label>
  );
}

function Segmented({ p }: CompProps) {
  const options = opts(p.options);
  const [v, setV, done] = useControlled<string>(p.value === undefined ? undefined : str(p.value), str(p.defaultValue, options[0]?.value ?? ""));
  const onChange = fn(p.onChange);
  return (
    <div className={labelCls}>
      {p.label && <span className="text-[13px] text-muted">{str(p.label)}</span>}
      <div className="flex gap-0.5 p-0.5 rounded-md bg-surface-2 w-max max-w-full overflow-x-auto no-scrollbar" role="radiogroup" aria-label={str(p.label)}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === v}
            onClick={() => {
              setV(o.value);
              done();
              onChange?.(o.raw);
            }}
            className={cx("h-6 px-2.5 rounded text-[12.5px] whitespace-nowrap inline-flex items-center gap-1.5 border", o.value === v ? "bg-surface border-line" : "border-transparent text-muted hover:text-[var(--text)]")}
          >
            {o.icon ? <IconView name={o.icon} size={13} /> : null}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({ p, check }: { p: Record<string, any>; check?: boolean }) {
  const [v, setV, done] = useControlled<boolean>(p.checked === undefined && p.value === undefined ? undefined : !!(p.checked ?? p.value), !!p.defaultChecked);
  const onChange = fn(p.onChange);
  const toggle = () => {
    setV(!v);
    done();
    onChange?.(!v);
  };
  return (
    <label className="flex items-center gap-2.5 min-w-0 cursor-pointer text-[13.5px]">
      {check ? (
        <input type="checkbox" checked={v} onChange={toggle} className="size-4 accent-[var(--color-accent)]" />
      ) : (
        <button type="button" role="switch" aria-checked={v} onClick={toggle} className={cx("relative w-9 h-5 rounded-full shrink-0 transition-colors", v ? "bg-accent" : "bg-[color-mix(in_oklab,var(--text)_18%,transparent)]")}>
          <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-[left]", v ? "left-[18px]" : "left-0.5")} />
        </button>
      )}
      <span className="flex-1 min-w-0">
        <Inline text={str(p.label)} />
        {p.desc && <span className="block text-xs text-muted"><Inline text={str(p.desc)} /></span>}
      </span>
    </label>
  );
}

/** Option cards to pick from (one, or several with `multiple`); `submit` adds a button that sends the choice. */
function Choice({ p, ctx }: CompProps) {
  const options = opts(p.options);
  const multiple = !!p.multiple;
  const init = p.value !== undefined ? (multiple ? (Array.isArray(p.value) ? p.value.map((x: unknown) => str(x)) : []) : [str(p.value)]) : undefined;
  const [sel, setSel, done] = useControlled<string[]>(init, []);
  const onChange = fn(p.onChange);
  const recommended = str(p.recommended);
  const pick = (val: string) => {
    const next = multiple ? (sel.includes(val) ? sel.filter((x) => x !== val) : [...sel, val]) : [val];
    setSel(next);
    done();
    onChange?.(multiple ? next.map((x) => rawOf(options, x)) : rawOf(options, val));
  };
  const submit = str(p.submit);
  return (
    <div className="min-w-0 space-y-1.5">
      {p.label && <div className="text-[13px] text-muted">{str(p.label)}</div>}
      <div className={cx(p.columns === 2 || p.cols === 2 ? "grid sm:grid-cols-2 gap-1.5" : "space-y-1.5")}>
        {options.map((o) => {
          const on = sel.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => pick(o.value)}
              className={cx(
                "w-full flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                on ? "border-[color-mix(in_oklab,var(--color-accent)_60%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_6%,transparent)]" : "border-line hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)]",
              )}
            >
              {o.icon ? <IconView name={o.icon} size={16} className={cx("mt-0.5", on ? "text-accent" : "text-muted")} /> : (
                <span className={cx("mt-0.5 size-4 shrink-0 grid place-items-center border", multiple ? "rounded" : "rounded-full", on ? "border-accent bg-accent text-white" : "border-line")}>{on && <Check className="size-3" strokeWidth={3} />}</span>
              )}
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                  {o.label}
                  {(o.badge || (recommended && recommended === o.value)) && <span className="rounded px-1.5 text-[11px] leading-[18px] bg-accent-soft text-accent font-normal">{o.badge ?? "推荐"}</span>}
                </span>
                {o.desc && <span className="block text-xs text-muted leading-relaxed mt-0.5"><Inline text={o.desc} /></span>}
              </span>
            </button>
          );
        })}
      </div>
      {submit && (
        <button
          type="button"
          disabled={!sel.length}
          onClick={() => ctx.send(`${submit}${submit.endsWith("：") || submit.endsWith(":") ? "" : "："}${sel.map((s) => options.find((o) => o.value === s)?.label ?? s).join("、")}`)}
          className="h-8 px-3 rounded-md bg-accent text-white text-[13.5px] font-medium disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          <Send className="size-3.5" strokeWidth={1.8} />
          {str(p.submitLabel, "发送")}
        </button>
      )}
    </div>
  );
}

function Button({ p, children, ctx }: CompProps) {
  const click = fn(p.onClick);
  const variant = ["primary", "secondary", "ghost", "danger"].includes(str(p.variant)) ? str(p.variant) : p.primary ? "primary" : "secondary";
  const href = safeUrl(p.href);
  const sendText = str(p.send);
  const copyText = p.copy !== undefined ? str(p.copy) : "";
  const cls = cx(
    "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[13.5px] whitespace-nowrap transition-colors disabled:opacity-40",
    variant === "primary" && "bg-accent text-white font-medium hover:brightness-105",
    variant === "secondary" && "border border-line bg-surface hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)]",
    variant === "ghost" && "text-muted hover:text-[var(--text)] hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]",
    variant === "danger" && "border border-[color-mix(in_oklab,var(--danger)_45%,transparent)] text-danger hover:bg-[color-mix(in_oklab,var(--danger)_6%,transparent)]",
    p.block && "w-full",
    str(p.size) === "sm" && "h-7 px-2.5 text-[13px]",
  );
  const icon = p.icon ? <IconView name={p.icon} size={14} /> : sendText ? <Send className="size-3.5" strokeWidth={1.8} /> : null;
  return (
    <button
      type="button"
      disabled={!!p.disabled}
      className={cls}
      onClick={() => {
        if (click) click();
        else if (sendText) ctx.send(sendText);
        else if (copyText) ctx.copy(copyText);
        else if (href) ctx.open(href);
      }}
    >
      {icon}
      {children ?? str(p.label)}
    </button>
  );
}

const Link = ({ p, children, ctx }: CompProps) => {
  const href = safeUrl(p.href);
  return (
    <a href={href || undefined} onClick={(e) => { e.preventDefault(); if (href) ctx.open(href); }} className="text-accent underline underline-offset-2 cursor-pointer">
      {children ?? href}
    </a>
  );
};

export const COMPONENTS: Record<string, (props: CompProps) => ReactNode> = {
  Box, Row, Col, Stack: Col, Grid, Card, Divider, Spacer, Caption,
  Text, Heading, Markdown: MarkdownC, Code, Icon, Badge, Kbd,
  Loading, Skeleton: Loading, Form,
  Stat, Progress, Table, Chart: ChartC, KeyValue, List, Item, Flow, Timeline,
  Steps, Tabs, Accordion, Details, Callout, Quiz, Image: ImageC, Suggestions,
  Slider, NumberInput, Input: ({ p }) => <TextInput p={p} />, TextArea: ({ p }) => <TextInput p={p} area />, Select, Segmented,
  Switch: ({ p }) => <Switch p={p} />, Checkbox: ({ p }) => <Switch p={p} check />, Choice, Button, Link,
  // Parts that only mean something inside their parent; alone they just show their content.
  Node: ({ p, kids, render }) => <FlowNode p={p} kids={kids} render={render} horizontal={false} />,
  Event: ({ children }) => <>{children}</>,
  Step: ({ children }) => <>{children}</>,
  Tab: ({ children }) => <>{children}</>,
};

/** Plain HTML and SVG tags the program may use, rendered with filtered attributes only. */
export const HTML_TAGS = new Set<string>(GENUI_HTML_TAGS);
export const SVG_TAGS = new Set<string>(GENUI_SVG_TAGS);

/** Children helper for components that render their raw kids. */
export const count = (n: ReactNode) => Children.count(n);
