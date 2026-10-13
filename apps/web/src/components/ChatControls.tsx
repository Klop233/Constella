import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { tokens } from "../lib/format";
import type { Effort, Run } from "../lib/types";
import { conversationUsage, type LatestStats } from "./RunView";
import { cx, Popover } from "./ui";

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
              <label className="flex items-center gap-2 px-2.5 mb-1 h-8 rounded-md bg-surface-2">
                <Search className="size-4 text-muted" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型" className="flex-1 bg-transparent outline-none text-[13px]" />
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
    <Popover label="推理强度" className="w-56 max-w-[calc(100vw-2rem)] p-3" trigger={<span>{value ? EFFORTS[idx]!.label : agentLabel && agentLabel !== "默认" ? agentLabel : "默认"}</span>}>
      {() => (
        <div className="space-y-3">
          <div className="flex items-center text-[13px]">
            <span className="flex-1 text-muted">推理强度</span>
            <span className="font-medium">{EFFORTS[idx]!.label}</span>
          </div>
          <div className="flex justify-between text-xs text-muted">
            <span>更快</span>
            <span>更聪明</span>
          </div>
          <div className="relative h-5 rounded-md bg-surface-2 flex items-center px-0.5">
            {EFFORTS.map((e, i) => (
              <button
                key={e.label}
                type="button"
                aria-label={e.label}
                aria-pressed={i === idx}
                onClick={() => onChange(e.value)}
                className="flex-1 h-full grid place-items-center"
              >
                {i === idx ? <span className="w-3 h-4 rounded-sm bg-[var(--text)] shadow-sm" /> : <span className="size-1 rounded-full bg-[var(--muted)] opacity-60" />}
              </button>
            ))}
          </div>
          <div className="text-xs text-muted">{value === null ? `跟随 agent 设置（${agentLabel ?? "模型默认"}）` : "只对这个对话生效"}</div>
        </div>
      )}
    </Popover>
  );
}

/** Thin stacked bar: segments separated by a 2px surface gap, the rest of the track left neutral. */
function Bar({ parts, total }: { parts: { value: number; color: string }[]; total: number }) {
  return (
    <div className="flex h-1.5 gap-0.5 rounded-full overflow-hidden bg-[color-mix(in_oklab,var(--text)_12%,transparent)]">
      {parts
        .filter((p) => p.value > 0)
        .map((p, i) => (
          <span key={i} className="shrink-0" style={{ width: `${Math.min(100, (p.value / total) * 100)}%`, background: p.color }} />
        ))}
    </div>
  );
}

function Legend({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      {color && <span className="size-2 rounded-sm shrink-0" style={{ background: color }} />}
      <span className="flex-1 text-muted truncate">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

interface Breakdown {
  used: number;
  window: number | null;
  measured: boolean;
  parts: { key: string; label: string; tokens: number }[];
}

/** Composer gauge for context occupancy; opens a panel with what fills the window and what it cost. */
export function ContextMeter({ stats, runs, agentId, conversationId }: { stats: LatestStats; runs: Run[]; agentId: string; conversationId: string }) {
  const { context, tps } = stats;
  const pct = context.window ? Math.min(1, context.tokens / context.window) : null;
  const ringColor = pct == null ? "var(--color-accent)" : pct > 0.85 ? "var(--danger)" : pct > 0.6 ? "var(--warn)" : "var(--color-accent)";
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <Popover
      label="上下文与用量"
      className="w-[22rem] max-w-[calc(100vw-2rem)]"
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
      {() => <ContextPanel stats={stats} runs={runs} agentId={agentId} conversationId={conversationId} />}
    </Popover>
  );
}

const SERIES: Record<string, string> = {
  persona: "var(--series-1)",
  memory: "var(--series-2)",
  skills: "var(--series-3)",
  builtin: "var(--series-4)",
  messages: "var(--series-5)",
  tools: "var(--series-6)",
};

function ContextPanel({ stats, runs, agentId, conversationId }: { stats: LatestStats; runs: Run[]; agentId: string; conversationId: string }) {
  const breakdown = useQuery({
    queryKey: ["context", conversationId, stats.context.tokens],
    queryFn: () => api.get<Breakdown>(`/api/conversations/${conversationId}/context`),
  });
  const today = useQuery({
    queryKey: ["agent-today", agentId],
    queryFn: () => api.get<{ runs: number; input: number; output: number; spentUsd: number | null; budgetUsd: number | null }>(`/api/agents/${agentId}/today`),
    staleTime: 30_000,
  });
  const { context } = stats;
  const conv = conversationUsage(runs);
  const b = breakdown.data;
  const t = today.data;
  const total = context.window ?? context.tokens;
  return (
    <div className="text-[13px] [&>*+*]:border-t [&>*+*]:border-line [&>*+*]:mx-3 [&>*+*]:px-0">
      <div className="p-3 space-y-2.5">
        <div className="flex items-baseline">
          <span className="flex-1 font-medium">上下文窗口</span>
          <span className="text-xs text-muted tabular-nums">
            {tokens(context.tokens)}
            {context.window ? ` / ${tokens(context.window)}（${Math.round((context.tokens / context.window) * 100)}%）` : ""}
          </span>
        </div>
        <Bar total={total} parts={(b?.parts ?? []).map((p) => ({ value: p.tokens, color: SERIES[p.key]! }))} />
        {!b ? (
          <div className="text-xs text-muted">计算中…</div>
        ) : (
          <div className="space-y-1.5">
            {b.parts.map((p) => (
              <Legend key={p.key} color={SERIES[p.key]} label={p.label} value={tokens(p.tokens)} />
            ))}
            {context.window && <Legend color="color-mix(in oklab, var(--text) 12%, transparent)" label="剩余空间" value={tokens(Math.max(0, context.window - context.tokens))} />}
          </div>
        )}
        <div className="text-[11.5px] text-muted">总量是最近一次请求的实测值，各部分按文本估算。</div>
      </div>
      <div className="py-3 space-y-1.5">
        <div className="font-medium mb-1">最近一次请求</div>
        <Legend label="输入" value={`${tokens(stats.input)}${stats.cached ? `（缓存命中 ${tokens(stats.cached)}）` : ""}`} />
        <Legend label={stats.reasoning ? `输出（含推理 ${tokens(stats.reasoning)}）` : "输出"} value={tokens(stats.output)} />
        {stats.tps != null && <Legend label="输出速度" value={`${stats.tps.toFixed(1)} tok/s`} />}
      </div>
      <div className="py-3 space-y-1.5">
        <div className="font-medium mb-1">这个对话</div>
        <Legend label={`${conv.runs} 次任务 · 输入`} value={`${tokens(conv.input)}${conv.cached ? `（缓存 ${tokens(conv.cached)}）` : ""}`} />
        <Legend label="输出" value={tokens(conv.output)} />
        {conv.timedMs > 0 && <Legend label="平均输出速度" value={`${(conv.timedOutput / (conv.timedMs / 1000)).toFixed(1)} tok/s`} />}
      </div>
      <div className="py-3 space-y-1.5">
        <div className="font-medium mb-1">今天（这个 agent）</div>
        {!t ? (
          <div className="text-xs text-muted">加载中…</div>
        ) : (
          <>
            <Legend label={`${t.runs} 次任务 · 输入 / 输出`} value={`${tokens(t.input)} / ${tokens(t.output)}`} />
            {t.budgetUsd ? (
              <>
                <Legend label="每日预算" value={t.spentUsd != null ? `$${t.spentUsd.toFixed(2)} / $${t.budgetUsd}` : `$${t.budgetUsd}（花费未知）`} />
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
