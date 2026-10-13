import { Brain, ChevronRight, CircleSlash, CircleX, FileEdit, Globe, Loader2, Monitor, RotateCw, ShieldCheck, ShieldX, Terminal, ThumbsDown, ThumbsUp, Wrench, X } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { useAppearance } from "../lib/appearance";
import { clock, duration, STATUS_TEXT, tokens } from "../lib/format";
import type { AgentEvent, Approval, Run } from "../lib/types";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { cx, toast } from "./ui";

type Item =
  | { kind: "message"; id: string; text: string; streaming: boolean; user: boolean }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output: string; done: boolean; ok: boolean; error?: string; result?: unknown }
  | { kind: "approval"; id: string; approvalId: string; summary: string; resolved?: "approve" | "deny"; by?: "user" | "policy" }
  | { kind: "desktop"; id: string; desktopId: string; action: string };

const STEER_PREFIX = "［追加指示］";
/** Same as MIN_TIMED_MS in apps/hub/src/usage.ts: shorter requests are timing artifacts and don't count toward speed. */
const MIN_TIMED_MS = 250;
/** Matches RESUME_PREFIX in apps/hub/src/runs.ts: runs the hub started itself after a restart. */
const RESUME_PREFIX = "［自动继续］";
/** Sent for an empty message after a task ended abnormally. */
export const CONTINUE_TEXT = "继续完成上次中断的任务。";

/** Folds a run's event stream into display items (streaming text, tool cards, approvals). */
export interface Usage {
  input: number;
  output: number;
  cached: number;
  /** Output tokens and wall time of the requests that reported a duration, for tokens/s. */
  timedOutput: number;
  timedMs: number;
  context: { tokens: number; window: number | null } | null;
}

export function buildItems(events: AgentEvent[]): { items: Item[]; usage: Usage } {
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  const usage: Usage = { input: 0, output: 0, cached: 0, timedOutput: 0, timedMs: 0, context: null };
  for (const ev of events) {
    switch (ev.type) {
      case "message.delta": {
        let it = byId.get(ev.messageId) as Extract<Item, { kind: "message" }> | undefined;
        if (!it) {
          it = { kind: "message", id: ev.messageId, text: "", streaming: true, user: false };
          byId.set(ev.messageId, it);
          items.push(it);
        }
        it.text += ev.text;
        break;
      }
      case "message.completed": {
        const user = ev.text.startsWith(STEER_PREFIX);
        const text = user ? ev.text.slice(STEER_PREFIX.length) : ev.text;
        const it = byId.get(ev.messageId) as Extract<Item, { kind: "message" }> | undefined;
        if (it) {
          it.text = text;
          it.streaming = false;
        } else {
          const n: Item = { kind: "message", id: ev.messageId, text, streaming: false, user };
          byId.set(ev.messageId, n);
          items.push(n);
        }
        break;
      }
      case "reasoning.summary":
        items.push({ kind: "reasoning", id: ev.id, text: ev.text.replace(/\*\*/g, "").trim() });
        break;
      case "tool.started": {
        const t: Item = { kind: "tool", id: ev.callId, name: ev.name, input: ev.input, output: "", done: false, ok: true };
        byId.set(ev.callId, t);
        items.push(t);
        break;
      }
      case "tool.output": {
        const t = byId.get(ev.callId) as Extract<Item, { kind: "tool" }> | undefined;
        if (t) t.output += ev.chunk;
        break;
      }
      case "tool.completed": {
        const t = byId.get(ev.callId) as Extract<Item, { kind: "tool" }> | undefined;
        if (t) Object.assign(t, { done: true, ok: ev.ok, error: ev.error, result: ev.result });
        break;
      }
      case "approval.requested": {
        const a: Item = { kind: "approval", id: ev.id, approvalId: ev.approvalId, summary: ev.summary };
        byId.set(`ap:${ev.approvalId}`, a);
        items.push(a);
        break;
      }
      case "approval.resolved": {
        const a = byId.get(`ap:${ev.approvalId}`) as Extract<Item, { kind: "approval" }> | undefined;
        if (a) Object.assign(a, { resolved: ev.decision, by: ev.by });
        break;
      }
      case "desktop.action":
        items.push({ kind: "desktop", id: ev.id, desktopId: ev.desktopId, action: ev.action });
        break;
      case "usage":
        usage.input += ev.inputTokens;
        usage.output += ev.outputTokens;
        usage.cached += ev.cachedInputTokens ?? 0;
        if (ev.durationMs && ev.durationMs >= MIN_TIMED_MS) {
          usage.timedOutput += ev.outputTokens;
          usage.timedMs += ev.durationMs;
        }
        if (ev.contextTokens != null) usage.context = { tokens: ev.contextTokens, window: ev.contextWindow ?? null };
        break;
    }
  }
  return { items, usage };
}

function toolTitle(name: string, input: any): { icon: typeof Terminal; title: string } {
  if (name === "shell") return { icon: Terminal, title: String(input?.command ?? "").replace(/^\/bin\/bash -lc /, "").replace(/^['"]|['"]$/g, "") };
  if (name === "edit") return { icon: FileEdit, title: `修改 ${(input?.files ?? []).map((f: string) => f.split("/").pop()).join("、")}` };
  if (name.startsWith("constella.browser")) return { icon: Globe, title: `${name.replace("constella.", "")} ${input?.url ?? input?.name ?? input?.text ?? ""}` };
  if (name.startsWith("constella.desktop")) return { icon: Monitor, title: `${name.replace("constella.", "")} ${input?.type ?? input?.reason ?? ""}` };
  if (name.startsWith("constella.")) return { icon: Wrench, title: name.replace("constella.", "") };
  return { icon: Wrench, title: name };
}

type ApprovalItem = Extract<Item, { kind: "approval" }>;
type Step = Extract<Item, { kind: "tool" | "reasoning" | "desktop" }> | ApprovalItem;
type Block = Exclude<Item, Step> | ApprovalItem | { kind: "steps"; id: string; steps: Step[] };

/**
 * Collapses each run of consecutive tool calls / reasoning / desktop actions / settled approvals into one block.
 * A pending approval stays its own block so its card can interrupt the flow.
 */
function groupSteps(items: Item[], pending: Set<string>): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === "tool" || it.kind === "reasoning" || it.kind === "desktop" || (it.kind === "approval" && !pending.has(it.approvalId))) {
      const last = out.at(-1);
      if (last?.kind === "steps") last.steps.push(it);
      else out.push({ kind: "steps", id: `steps:${it.id}`, steps: [it] });
    } else out.push(it);
  }
  return out;
}

function approvalOutcome(a: ApprovalItem): string {
  return a.resolved === "approve" ? (a.by === "policy" ? "已自动批准" : "已批准") : a.resolved === "deny" ? "已拒绝" : "已失效";
}

const ToolRow = memo(function ToolRow({ item, ended }: { item: Extract<Item, { kind: "tool" }>; ended: boolean }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, title } = toolTitle(item.name, item.input);
  return (
    <div>
      <button className="w-full flex items-center gap-2 py-1 text-left text-[12.5px] text-muted hover:text-[var(--text)]" onClick={() => setOpen(!open)}>
        <Icon className="size-3.5 shrink-0" />
        <span className="font-mono truncate flex-1">{title || item.name}</span>
        {!item.done ? (
          ended ? (
            <CircleSlash aria-label="未完成" className="size-3.5 shrink-0" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-accent shrink-0" />
          )
        ) : (
          !item.ok && <X className="size-3.5 text-danger shrink-0" />
        )}
      </button>
      {open && (
        <div className="mb-1.5 ml-5.5 space-y-1.5 text-xs">
          <pre className="font-mono whitespace-pre-wrap break-all text-muted max-h-40 overflow-auto">{JSON.stringify(item.input, null, 2)}</pre>
          {item.output && <pre className="font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-md px-2.5 py-2 max-h-72 overflow-auto">{item.output}</pre>}
          {item.result != null && !item.output && <pre className="font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-md px-2.5 py-2 max-h-72 overflow-auto">{JSON.stringify(item.result, null, 2)}</pre>}
          {item.error && <div className="text-danger">{item.error}</div>}
        </div>
      )}
    </div>
  );
});

function StepRow({ step, ended }: { step: Step; ended: boolean }) {
  if (step.kind === "tool") return <ToolRow item={step} ended={ended} />;
  if (step.kind === "reasoning")
    return (
      <div className="flex items-start gap-2 py-1 text-[12.5px] text-muted">
        <Brain className="size-3.5 mt-0.5 shrink-0" />
        <span className="whitespace-pre-wrap">{step.text}</span>
      </div>
    );
  if (step.kind === "approval") {
    const Icon = step.resolved === "deny" ? ShieldX : ShieldCheck;
    return (
      <div className="flex items-start gap-2 py-1 text-[12.5px] text-muted">
        <Icon className="size-3.5 mt-0.5 shrink-0" />
        <span className="min-w-0 break-all">
          审批 <span className="font-mono">{step.summary}</span> · {approvalOutcome(step)}
        </span>
      </div>
    );
  }
  return (
    <Link to={`/desktops/${step.desktopId}`} className="flex items-center gap-2 py-1 text-[12.5px] text-muted hover:text-[var(--text)]">
      <Monitor className="size-3.5 shrink-0" /> {step.action}
    </Link>
  );
}

function stepLabel(step: Step): string {
  if (step.kind === "tool") return toolTitle(step.name, step.input).title || step.name;
  if (step.kind === "reasoning") return step.text.split("\n")[0] ?? "";
  if (step.kind === "approval") return `审批 ${step.summary}`;
  return step.action;
}

/** What a run of steps did, e.g. "运行了 2 条命令，修改了 1 处文件", plus how its approvals went; and an icon for it. */
function stepsSummary(steps: Step[]): { icon: typeof Terminal; text: string; approvals: string } {
  let cmds = 0;
  let edits = 0;
  let others = 0;
  const outcomes = new Map<string, number>();
  for (const s of steps) {
    if (s.kind === "approval") outcomes.set(approvalOutcome(s), (outcomes.get(approvalOutcome(s)) ?? 0) + 1);
    if (s.kind !== "tool") continue;
    if (s.name === "shell") cmds++;
    else if (s.name === "edit") edits++;
    else others++;
  }
  const parts = [cmds && `运行了 ${cmds} 条命令`, edits && `修改了 ${edits} 处文件`, others && `调用了 ${others} 个工具`].filter(Boolean);
  const approvals = [...outcomes].map(([o, n]) => `${n} 项审批${o}`).join("，");
  const icon = !parts.length ? (approvals ? ShieldCheck : Brain) : cmds >= edits && cmds >= others ? Terminal : edits >= others ? FileEdit : Wrench;
  return { icon, text: parts.length ? parts.join("，") : approvals ? "" : "思考过程", approvals };
}

/** One collapsible line per run of consecutive steps, like Claude Code's "Ran 3 commands ›". */
function StepGroup({ steps, live, ended }: { steps: Step[]; live: boolean; ended: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((s) => s.kind === "tool" && s.done && !s.ok).length;
  const { icon: Icon, text, approvals } = stepsSummary(steps);
  return (
    <div>
      <button className="flex items-center gap-2 max-w-full h-6 text-left text-[13px] text-muted hover:text-[var(--text)]" aria-expanded={open} onClick={() => setOpen(!open)}>
        {live ? <Loader2 className="size-3.5 animate-spin text-accent shrink-0" /> : <Icon className="size-3.5 shrink-0" />}
        <span className="flex items-center gap-1 min-w-0">
          <span className={cx("truncate", live && "font-mono text-[12.5px]")}>{live ? stepLabel(steps.at(-1)!) : [text, approvals].filter(Boolean).join(" · ")}</span>
          {failed > 0 && <span className="text-danger shrink-0">· {failed} 个失败</span>}
          <ChevronRight className={cx("size-3.5 shrink-0 transition", open && "rotate-90")} />
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-1 ml-[6.5px] pl-3.5 border-l border-line">
          {steps.map((st) => (
            <StepRow key={st.id} step={st} ended={ended} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The user's message, right-aligned; its time (or a label like 追加指示) sits beside it instead of on a line of its own. */
export function UserBubble({ text, meta }: { text: string; meta?: string }) {
  return (
    <div className="flex items-end justify-end gap-2.5">
      {meta && <span className="shrink-0 pb-2 text-[11px] text-muted tabular-nums">{meta}</span>}
      <div className="max-w-[85%] bg-surface-2 rounded-xl px-3 py-2 whitespace-pre-wrap break-words text-sm">{text}</div>
    </div>
  );
}

/** A turn the user didn't type (hub auto-resume, or an empty "continue" send): a centered divider instead of a bubble. */
function TurnDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[12px] text-muted">
      <span className="flex-1 h-px bg-[var(--border)]" />
      <span className="flex items-center gap-1.5 tabular-nums">{children}</span>
      <span className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

export interface LatestStats {
  context: NonNullable<Usage["context"]>;
  /** Breakdown of the latest model request. */
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  tps: number | null;
}

/** Context occupancy and output speed of the latest model request in these runs (newest last). */
export function latestStats(runs: Run[]): LatestStats | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const ev = runs[i]!.events.findLast((e) => e.type === "usage" && e.contextTokens != null);
    if (ev?.type === "usage") {
      return {
        context: { tokens: ev.contextTokens!, window: ev.contextWindow ?? null },
        input: ev.inputTokens,
        cached: ev.cachedInputTokens ?? 0,
        output: ev.outputTokens,
        reasoning: ev.reasoningTokens ?? 0,
        tps: ev.durationMs && ev.durationMs >= MIN_TIMED_MS && ev.outputTokens ? ev.outputTokens / (ev.durationMs / 1000) : null,
      };
    }
  }
  return null;
}

/** Usage summed over every run of a conversation. */
export function conversationUsage(runs: Run[]): Usage & { runs: number } {
  const total: Usage & { runs: number } = { input: 0, output: 0, cached: 0, timedOutput: 0, timedMs: 0, context: null, runs: runs.length };
  for (const r of runs) {
    const { usage } = buildItems(r.events);
    total.input += usage.input || r.input_tokens;
    total.output += usage.output || r.output_tokens;
    total.cached += usage.cached;
    total.timedOutput += usage.timedOutput;
    total.timedMs += usage.timedMs;
  }
  return total;
}

function UsageLine({ run, usage }: { run: Run; usage: Usage }) {
  const input = usage.input || run.input_tokens;
  const output = usage.output || run.output_tokens;
  const parts: string[] = [];
  if (usage.context) {
    const { tokens: used, window } = usage.context;
    parts.push(window ? `上下文 ${tokens(used)} / ${tokens(window)} (${Math.round((used / window) * 100)}%)` : `上下文 ${tokens(used)}`);
  }
  parts.push(`入 ${tokens(input)}${usage.cached ? ` (缓存 ${tokens(usage.cached)})` : ""}`);
  parts.push(`出 ${tokens(output)}`);
  if (usage.timedMs > 0 && usage.timedOutput > 0) parts.push(`${(usage.timedOutput / (usage.timedMs / 1000)).toFixed(1)} tok/s`);
  if (run.finished_at) parts.push(duration(Date.parse(run.finished_at) - Date.parse(run.created_at)));
  return <>{parts.join(" · ")}</>;
}

/** A process-level line in a turn (status, failure, stop): same 13px / 14px-icon rhythm as the step rows. */
function StatusLine({ icon, tone, children }: { icon: ReactNode; tone?: "danger"; children: ReactNode }) {
  return (
    <div className={cx("flex items-start gap-2 text-[13px] leading-6", tone === "danger" ? "text-danger" : "text-muted")}>
      <span className="h-6 grid place-items-center shrink-0">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * One turn: the user's message, then the agent's work (text in full, process folded into one-line rows),
 * then a footer with how it ended, the model and usage, and feedback (revealed on hover where there is one).
 */
export function RunView({ run, approvals, onChanged }: { run: Run; approvals: Approval[]; onChanged: () => void }) {
  const { items, usage } = useMemo(() => buildItems(run.events), [run.events]);
  const pending = useMemo(() => new Map(approvals.map((a) => [a.id, a])), [approvals]);
  const blocks = useMemo(() => groupSteps(items, new Set(pending.keys())), [items, pending]);
  const finished = ["done", "failed", "cancelled"].includes(run.status);
  const { usage: showUsage } = useAppearance();
  const feedback = async (value: 1 | -1) => {
    try {
      await api.post(`/api/runs/${run.id}/feedback`, { value });
      toast(value === 1 ? "谢谢！会据此总结经验" : "已记录，会复盘这次的问题");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  const time = clock(run.created_at);
  return (
    <article className="group/turn space-y-3">
      {run.prompt.startsWith(RESUME_PREFIX) ? (
        <TurnDivider>
          <RotateCw className="size-3" /> 中断后自动继续 · {time}
        </TurnDivider>
      ) : run.prompt === CONTINUE_TEXT ? (
        <TurnDivider>
          <RotateCw className="size-3" /> 继续中断的任务 · {time}
        </TurnDivider>
      ) : (
        <UserBubble text={run.prompt} meta={time} />
      )}
      {blocks.map((it, i) => {
        switch (it.kind) {
          case "message":
            return it.user ? <UserBubble key={it.id} text={it.text} meta="追加指示" /> : <Markdown key={it.id} text={it.text} className="font-display text-sm" />;
          case "steps":
            return <StepGroup key={it.id} steps={it.steps} live={!finished && i === blocks.length - 1} ended={finished} />;
          case "approval": {
            const a = pending.get(it.approvalId);
            return a ? <ApprovalCard key={it.id} approval={a} showAgent={false} onResolved={onChanged} /> : null;
          }
        }
      })}
      {!finished && !(run.status === "running" && blocks.at(-1)?.kind === "steps") && (
        <StatusLine icon={<Loader2 className="size-3.5 animate-spin text-accent" />}>{STATUS_TEXT[run.status]}…</StatusLine>
      )}
      {run.status === "failed" && <StatusLine tone="danger" icon={<CircleX className="size-3.5" />}>任务失败：{run.error ?? "未知错误"}</StatusLine>}
      {run.status === "cancelled" && <StatusLine icon={<CircleSlash className="size-3.5" />}>已停止{run.error ? `（${run.error}）` : ""}</StatusLine>}
      {finished && (
        <footer className="flex items-start gap-2 -mt-1 text-[11px] text-muted tabular-nums">
          <span className="flex-1 min-w-0 py-[3px] leading-[18px]">
            {run.model}
            {showUsage && (
              <>
                {" · "}
                <UsageLine run={run} usage={usage} />
              </>
            )}
          </span>
          <span className={cx("flex items-center shrink-0 -mr-1 transition-opacity", run.feedback == null && "pointer-fine:opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100")}>
            <button aria-label="有帮助" title="有帮助" onClick={() => feedback(1)} className={cx("size-6 grid place-items-center rounded-md hover:bg-surface-2 hover:text-[var(--text)]", run.feedback === 1 && "text-accent")}>
              <ThumbsUp className="size-3.5" />
            </button>
            <button aria-label="没帮助" title="没帮助" onClick={() => feedback(-1)} className={cx("size-6 grid place-items-center rounded-md hover:bg-surface-2 hover:text-[var(--text)]", run.feedback === -1 && "text-danger")}>
              <ThumbsDown className="size-3.5" />
            </button>
          </span>
        </footer>
      )}
    </article>
  );
}
