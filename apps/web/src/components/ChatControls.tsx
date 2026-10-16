import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Search, Timer } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { effortLabel, fitIndex, modelEfforts } from "../lib/effort";
import { RUN_TIMEOUTS, runTimeoutLabel, tokens } from "../lib/format";
import { useModelLabel, useModels } from "../lib/models";
import type { Effort, Run } from "../lib/types";
import { conversationUsage, type LatestStats } from "./RunView";
import { cx, Popover } from "./ui";

/** Per-conversation model; `null` follows the agent's model. */
export function ModelPicker({ value, agentModel, onChange }: { value: string | null; agentModel: string; onChange: (v: string | null) => void }) {
  const models = useModels();
  const label = useModelLabel();
  const [q, setQ] = useState("");
  const needle = q.toLowerCase();
  const list = (models.data ?? []).filter((m) => `${m.label} ${m.model} ${m.providerName}`.toLowerCase().includes(needle));
  const current = label(value ?? agentModel);
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
        const item = (id: string | null, title: ReactNode) => (
          <button key={id ?? "default"} type="button" onClick={() => pick(id)} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-surface-2">
            <span className="flex-1 min-w-0 truncate">{title}</span>
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
            {!q && item(null, "跟随 agent")}
            <div className="max-h-72 overflow-y-auto">
              {models.isLoading && <div className="px-3 py-2 text-sm text-muted">加载中…</div>}
              {list.map((m) => item(m.ref, m.label))}
            </div>
          </div>
        );
      }}
    </Popover>
  );
}

/** Per-conversation reasoning effort, as a Faster ↔ Smarter slider with one stop per level the model supports; `null` follows the agent. */
export function EffortPicker({ value, agentEffort, model, onChange }: { value: Effort | null; agentEffort: Effort | null; model: string; onChange: (v: Effort | null) => void }) {
  const models = useModels();
  const { efforts, defaultEffort } = modelEfforts(models.data, model);
  const [preview, setPreview] = useState<number | null>(null);
  if (!efforts.length) return null;
  const inherited = agentEffort ?? defaultEffort;
  const idx = value ? fitIndex(efforts, value) : inherited ? fitIndex(efforts, inherited) : Math.max(0, efforts.indexOf("medium"));
  const shown = effortLabel(efforts[preview ?? idx]!);
  return (
    <Popover label="推理强度" className="w-56 max-w-[calc(100vw-2rem)] p-3" trigger={<span>{value || inherited ? effortLabel(efforts[idx]!) : "默认"}</span>}>
      {() => (
        <div className="space-y-3">
          <div className="flex items-center text-[13px]">
            <span className="flex-1 text-muted">推理强度</span>
            <span className="font-medium">{shown}</span>
          </div>
          <div className="flex justify-between text-xs text-muted">
            <span>更快</span>
            <span>更聪明</span>
          </div>
          <StepSlider
            label="推理强度"
            steps={efforts.map(effortLabel)}
            index={idx}
            onPreview={setPreview}
            onChange={(i) => i !== idx && onChange(efforts[i]!)}
          />
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="flex-1">
              {value !== null ? "只对这个对话生效" : agentEffort ? `跟随 agent 设置（${effortLabel(efforts[idx]!)}）` : `模型默认${inherited ? `（${effortLabel(efforts[idx]!)}）` : ""}`}
            </span>
            {value !== null && (
              <button type="button" onClick={() => onChange(null)} className="text-accent hover:underline">
                恢复默认
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Per-conversation single-turn time limit; `null` follows the setting, 0 lets a turn run as long as it needs. */
export function RunTimeoutPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ runTimeoutMinutes: number }>("/api/settings"), staleTime: 60_000 });
  const inherited = settings.data?.runTimeoutMinutes;
  const item = (v: number | null, title: string, close: () => void, sub?: string) => (
    <button
      key={v ?? "default"}
      type="button"
      onClick={() => {
        onChange(v);
        close();
      }}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-surface-2"
    >
      <span className="flex-1 min-w-0">
        <span className="block truncate">{title}</span>
        {sub && <span className="block text-xs text-muted truncate">{sub}</span>}
      </span>
      {value === v && <Check className="size-4 text-accent shrink-0" />}
    </button>
  );
  return (
    <Popover
      label="单轮最长运行"
      className="w-56 max-w-[calc(100vw-2rem)]"
      trigger={
        <>
          <Timer className={cx("size-4", value !== null && "text-accent")} />
          {value !== null && <span className="hidden sm:inline">{runTimeoutLabel(value)}</span>}
        </>
      }
    >
      {(close) => (
        <div className="p-1.5">
          <div className="px-2.5 pt-1 pb-1.5 text-xs text-muted">单轮最长运行，只对这个对话生效</div>
          {item(null, "跟随设置", close, inherited === undefined ? undefined : runTimeoutLabel(inherited))}
          {RUN_TIMEOUTS.map((m) => item(m, runTimeoutLabel(m), close))}
        </div>
      )}
    </Popover>
  );
}

/**
 * A track with one stop per step and a thumb that follows the pointer while dragging, then snaps to the
 * nearest stop. `onChange` fires once on release (or per key press), so dragging never hits the network.
 */
function StepSlider({ label, steps, index, onChange, onPreview }: { label: string; steps: string[]; index: number; onChange: (i: number) => void; onPreview: (i: number | null) => void }) {
  const track = useRef<HTMLDivElement>(null);
  /** Thumb position while dragging, as a fraction of the track width; null when resting on `index`. */
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const n = steps.length;
  const center = (i: number) => (i + 0.5) / n;
  const at = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(center(n - 1), Math.max(center(0), (e.clientX - r.left) / r.width));
  };
  const nearest = (f: number) => Math.min(n - 1, Math.max(0, Math.round(f * n - 0.5)));
  const move = (f: number) => {
    dragRef.current = f;
    setDrag(f);
    onPreview(nearest(f));
  };
  const end = (commit: boolean) => {
    if (dragRef.current === null) return;
    if (commit) onChange(nearest(dragRef.current));
    dragRef.current = null;
    setDrag(null);
    onPreview(null);
  };
  const key = (e: KeyboardEvent) => {
    const next = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onChange(Math.min(n - 1, Math.max(0, next)));
  };
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={index}
      aria-valuetext={steps[index]}
      onKeyDown={key}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(at(e));
      }}
      onPointerMove={(e) => dragRef.current !== null && move(at(e))}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      className="relative h-5 rounded-md bg-surface-2 touch-none select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {steps.map((s, i) => (
        <span key={s} className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--muted)] opacity-60" style={{ left: `${center(i) * 100}%` }} />
      ))}
      <span
        className={cx("absolute top-1/2 w-3 h-4 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-[var(--text)] shadow-sm", drag === null && "transition-[left] duration-150 ease-out")}
        style={{ left: `${(drag ?? center(index)) * 100}%` }}
      />
    </div>
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
    queryFn: () => api.get<{ runs: number; input: number; output: number }>(`/api/agents/${agentId}/today`),
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
          <Legend label={`${t.runs} 次任务 · 输入 / 输出`} value={`${tokens(t.input)} / ${tokens(t.output)}`} />
        )}
      </div>
    </div>
  );
}
