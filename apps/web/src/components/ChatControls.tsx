import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { tokens } from "../lib/format";
import type { Effort, Run } from "../lib/types";
import { conversationUsage, type LatestStats } from "./RunView";
import { cx } from "./ui";

/** A button that opens a panel above itself; closes on outside click or Escape. */
function Popover({ label, trigger, children, className }: { label: string; trigger: ReactNode; children: (close: () => void) => ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx("flex items-center gap-1 h-8 px-2 rounded-lg text-xs text-muted hover:text-[var(--text)] hover:bg-surface-2 tabular-nums", open && "bg-surface-2 text-[var(--text)]")}
      >
        {trigger}
      </button>
      {open && (
        <div role="dialog" aria-label={label} className={cx("absolute bottom-full right-0 mb-2 z-40 rounded-xl border border-line bg-surface shadow-xl", className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

interface Model {
  id: string;
  compat?: "ok" | "upstream_error";
}

/** Per-conversation model; `null` follows the agent's model. */
export function ModelPicker({ value, agentModel, onChange }: { value: string | null; agentModel: string; onChange: (v: string | null) => void }) {
  const models = useQuery({ queryKey: ["models"], queryFn: () => api.get<Model[]>("/api/models"), staleTime: 300_000 });
  const [q, setQ] = useState("");
  const list = (models.data ?? []).filter((m) => m.id.toLowerCase().includes(q.toLowerCase()));
  const current = value ?? agentModel;
  return (
    <Popover
      label="选择模型"
      className="w-72 max-w-[calc(100vw-2rem)]"
      trigger={
        <>
          <span className="max-w-28 sm:max-w-40 truncate">{current}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </>
      }
    >
      {(close) => {
        const pick = (v: string | null) => {
          onChange(v);
          close();
        };
        const item = (id: string | null, title: ReactNode, sub?: string) => (
          <button key={id ?? "default"} type="button" onClick={() => pick(id)} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-surface-2">
            <span className="flex-1 min-w-0">
              <span className="block truncate">{title}</span>
              {sub && <span className="block text-xs text-muted truncate">{sub}</span>}
            </span>
            {value === id && <Check className="size-4 text-accent shrink-0" />}
          </button>
        );
        return (
          <div className="p-1.5">
            {(models.data?.length ?? 0) > 8 && (
              <label className="flex items-center gap-2 px-2.5 mb-1 h-9 rounded-lg bg-surface-2">
                <Search className="size-4 text-muted" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型" className="flex-1 bg-transparent outline-none text-sm" />
              </label>
            )}
            {!q && item(null, "跟随 agent", agentModel)}
            <div className="max-h-72 overflow-y-auto">
              {models.isLoading && <div className="px-3 py-2 text-sm text-muted">加载中…</div>}
              {list.map((m) => item(m.id, m.id, m.compat === "ok" ? "已验证可用" : m.compat === "upstream_error" ? "上游报错过" : undefined))}
            </div>
          </div>
        );
      }}
    </Popover>
  );
}

const EFFORTS: { value: Effort | null; label: string }[] = [
  { value: null, label: "默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

/** Per-conversation reasoning effort, as a Faster ↔ Smarter slider; `null` follows the agent. */
export function EffortPicker({ value, agentEffort, onChange }: { value: Effort | null; agentEffort: string | null; onChange: (v: Effort | null) => void }) {
  const idx = Math.max(0, EFFORTS.findIndex((e) => e.value === value));
  const agentLabel = EFFORTS.find((e) => e.value === agentEffort)?.label;
  return (
    <Popover label="推理强度" className="w-64 max-w-[calc(100vw-2rem)] p-3.5" trigger={<span>{value ? EFFORTS[idx]!.label : agentLabel && agentLabel !== "默认" ? agentLabel : "默认"}</span>}>
      {() => (
        <div className="space-y-3">
          <div className="flex items-center text-sm">
            <span className="flex-1 text-muted">推理强度</span>
            <span className="font-medium">{EFFORTS[idx]!.label}</span>
          </div>
          <div className="flex justify-between text-xs text-muted">
            <span>更快</span>
            <span>更聪明</span>
          </div>
          <div className="relative h-7 rounded-full bg-surface-2 flex items-center px-1">
            {EFFORTS.map((e, i) => (
              <button
                key={e.label}
                type="button"
                aria-label={e.label}
                aria-pressed={i === idx}
                onClick={() => onChange(e.value)}
                className="flex-1 h-full grid place-items-center"
              >
                {i === idx ? <span className="size-5 rounded-full bg-accent-grad shadow" /> : <span className="size-1.5 rounded-full bg-[var(--muted)] opacity-50" />}
              </button>
            ))}
          </div>
          <div className="text-xs text-muted">{value === null ? `跟随 agent 设置（${agentLabel ?? "模型默认"}）` : "只对这个对话生效"}</div>
        </div>
      )}
    </Popover>
  );
}

function Bar({ parts, total }: { parts: { value: number; color: string }[]; total: number }) {
  return (
    <div className="flex h-1.5 rounded-full bg-surface-2 overflow-hidden">
      {parts.map((p, i) => (
        <span key={i} style={{ width: `${Math.min(100, (p.value / total) * 100)}%`, background: p.color }} />
      ))}
    </div>
  );
}

function Legend({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {color && <span className="size-2 rounded-sm shrink-0" style={{ background: color }} />}
      <span className="flex-1 text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** Composer gauge for context occupancy; opens a panel with the full breakdown. */
export function ContextMeter({ stats, runs, agentId }: { stats: LatestStats; runs: Run[]; agentId: string }) {
  const { context, tps } = stats;
  const pct = context.window ? Math.min(1, context.tokens / context.window) : null;
  const ringColor = pct == null ? "var(--color-accent)" : pct > 0.85 ? "var(--danger)" : pct > 0.6 ? "var(--warn)" : "var(--color-accent)";
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <Popover
      label="上下文与用量"
      className="w-80 max-w-[calc(100vw-2rem)]"
      trigger={
        <>
          {tps != null && <span className="hidden sm:inline mr-1">{tps.toFixed(0)} tok/s</span>}
          <svg viewBox="0 0 18 18" className="size-4 -rotate-90">
            <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
            <circle cx="9" cy="9" r={r} fill="none" stroke={ringColor} strokeWidth="2.5" strokeDasharray={`${(pct ?? 0) * c} ${c}`} strokeLinecap="round" />
          </svg>
          <span>{pct != null ? `${Math.round(pct * 100)}%` : tokens(context.tokens)}</span>
        </>
      }
    >
      {() => <ContextPanel stats={stats} runs={runs} agentId={agentId} />}
    </Popover>
  );
}

function ContextPanel({ stats, runs, agentId }: { stats: LatestStats; runs: Run[]; agentId: string }) {
  const today = useQuery({
    queryKey: ["agent-today", agentId],
    queryFn: () => api.get<{ runs: number; input: number; output: number; spentUsd: number | null; budgetUsd: number | null }>(`/api/agents/${agentId}/today`),
    staleTime: 30_000,
  });
  const { context } = stats;
  const conv = conversationUsage(runs);
  const fresh = Math.max(0, stats.input - stats.cached);
  const total = context.window ?? context.tokens;
  const colors = { cached: "var(--color-accent)", fresh: "var(--accent-2)", output: "var(--muted)" };
  const t = today.data;
  return (
    <div className="divide-y divide-[var(--border)] text-sm">
      <div className="p-3.5 space-y-2.5">
        <div className="flex items-baseline">
          <span className="flex-1 font-medium">上下文窗口</span>
          <span className="text-xs text-muted tabular-nums">
            {tokens(context.tokens)}
            {context.window ? ` / ${tokens(context.window)}（${Math.round((context.tokens / context.window) * 100)}%）` : ""}
          </span>
        </div>
        <Bar
          total={total}
          parts={[
            { value: stats.cached, color: colors.cached },
            { value: fresh, color: colors.fresh },
            { value: stats.output, color: colors.output },
          ]}
        />
        <div className="space-y-1.5">
          <Legend color={colors.cached} label="缓存命中的输入" value={tokens(stats.cached)} />
          <Legend color={colors.fresh} label="新输入" value={tokens(fresh)} />
          <Legend color={colors.output} label={stats.reasoning ? `输出（含推理 ${tokens(stats.reasoning)}）` : "输出"} value={tokens(stats.output)} />
          {context.window && <Legend color="color-mix(in oklab, var(--text) 12%, transparent)" label="剩余" value={tokens(Math.max(0, context.window - context.tokens))} />}
        </div>
        <div className="text-[11px] text-muted">按最近一次模型请求统计{stats.tps ? ` · 输出速度 ${stats.tps.toFixed(1)} tok/s` : ""}</div>
      </div>
      <div className="p-3.5 space-y-1.5">
        <div className="font-medium mb-1">这个对话</div>
        <Legend label={`${conv.runs} 次任务 · 输入`} value={`${tokens(conv.input)}${conv.cached ? `（缓存 ${tokens(conv.cached)}）` : ""}`} />
        <Legend label="输出" value={tokens(conv.output)} />
        {conv.timedMs > 0 && <Legend label="平均输出速度" value={`${(conv.timedOutput / (conv.timedMs / 1000)).toFixed(1)} tok/s`} />}
      </div>
      <div className="p-3.5 space-y-2">
        <div className="font-medium">今天（这个 agent）</div>
        {!t ? (
          <div className="text-xs text-muted">加载中…</div>
        ) : (
          <>
            <Legend label={`${t.runs} 次任务 · 输入 / 输出`} value={`${tokens(t.input)} / ${tokens(t.output)}`} />
            {t.budgetUsd ? (
              <>
                <div className="flex items-baseline text-xs">
                  <span className="flex-1 text-muted">每日预算</span>
                  <span className="tabular-nums">{t.spentUsd != null ? `$${t.spentUsd.toFixed(2)} / $${t.budgetUsd}` : `$${t.budgetUsd}（花费未知）`}</span>
                </div>
                {t.spentUsd != null && <Bar total={t.budgetUsd} parts={[{ value: t.spentUsd, color: t.spentUsd / t.budgetUsd > 0.85 ? "var(--danger)" : "var(--color-accent)" }]} />}
              </>
            ) : (
              t.spentUsd != null && <Legend label="花费" value={`$${t.spentUsd.toFixed(2)}`} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
