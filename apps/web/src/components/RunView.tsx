import { Brain, Check, ChevronDown, CircleAlert, FileEdit, Globe, Loader2, Monitor, Terminal, ThumbsDown, ThumbsUp, Wrench, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { clock, STATUS_TEXT, tokens } from "../lib/format";
import type { AgentEvent, Approval, Run } from "../lib/types";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { cx, toast } from "./ui";

type Item =
  | { kind: "message"; id: string; text: string; streaming: boolean; user: boolean }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output: string; done: boolean; ok: boolean; error?: string; result?: unknown }
  | { kind: "approval"; id: string; approvalId: string; summary: string; resolved?: "approve" | "deny" }
  | { kind: "desktop"; id: string; desktopId: string; action: string };

const STEER_PREFIX = "［追加指示］";

/** Folds a run's event stream into display items (streaming text, tool cards, approvals). */
export function buildItems(events: AgentEvent[]): { items: Item[]; usage: { input: number; output: number } } {
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  const usage = { input: 0, output: 0 };
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
        if (a) a.resolved = ev.decision;
        break;
      }
      case "desktop.action":
        items.push({ kind: "desktop", id: ev.id, desktopId: ev.desktopId, action: ev.action });
        break;
      case "usage":
        usage.input += ev.inputTokens;
        usage.output += ev.outputTokens;
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

type Step = Extract<Item, { kind: "tool" | "reasoning" | "desktop" }>;
type Block = Exclude<Item, Step> | { kind: "steps"; id: string; steps: Step[] };

/** Collapses each run of consecutive tool calls / reasoning / desktop actions into one block. */
function groupSteps(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === "tool" || it.kind === "reasoning" || it.kind === "desktop") {
      const last = out.at(-1);
      if (last?.kind === "steps") last.steps.push(it);
      else out.push({ kind: "steps", id: `steps:${it.id}`, steps: [it] });
    } else out.push(it);
  }
  return out;
}

const ToolRow = memo(function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, title } = toolTitle(item.name, item.input);
  return (
    <div>
      <button className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2" onClick={() => setOpen(!open)}>
        <Icon className="size-3.5 text-muted shrink-0" />
        <span className="font-mono truncate flex-1">{title || item.name}</span>
        {!item.done ? <Loader2 className="size-3.5 animate-spin text-accent" /> : item.ok ? <Check className="size-3.5 text-ok" /> : <X className="size-3.5 text-danger" />}
        <ChevronDown className={cx("size-3.5 text-muted transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3 pb-2 pl-8 space-y-2 text-xs">
          <pre className="font-mono whitespace-pre-wrap break-all text-muted max-h-40 overflow-auto">{JSON.stringify(item.input, null, 2)}</pre>
          {item.output && <pre className="font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-md p-2 max-h-72 overflow-auto">{item.output}</pre>}
          {item.result != null && !item.output && <pre className="font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-md p-2 max-h-72 overflow-auto">{JSON.stringify(item.result, null, 2)}</pre>}
          {item.error && <div className="text-danger">{item.error}</div>}
        </div>
      )}
    </div>
  );
});

function StepRow({ step }: { step: Step }) {
  if (step.kind === "tool") return <ToolRow item={step} />;
  if (step.kind === "reasoning")
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 text-xs text-muted">
        <Brain className="size-3.5 mt-px shrink-0" />
        <span className="whitespace-pre-wrap">{step.text}</span>
      </div>
    );
  return (
    <Link to={`/desktops/${step.desktopId}`} className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted hover:bg-surface-2">
      <Monitor className="size-3.5 shrink-0" /> {step.action}
    </Link>
  );
}

function stepLabel(step: Step): string {
  if (step.kind === "tool") return toolTitle(step.name, step.input).title || step.name;
  if (step.kind === "reasoning") return step.text.split("\n")[0] ?? "";
  return step.action;
}

/** One card per run of consecutive steps: a one-line summary that expands into the full list. */
function StepGroup({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = steps.filter((s) => s.kind === "tool") as Extract<Item, { kind: "tool" }>[];
  const failed = tools.filter((t) => t.done && !t.ok).length;
  const last = steps.at(-1)!;
  const summary = live ? stepLabel(last) : tools.length ? `执行了 ${tools.length} 个操作` : "思考过程";
  return (
    <div className="rounded-lg border border-line bg-surface overflow-hidden">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px]" onClick={() => setOpen(!open)}>
        {live ? <Loader2 className="size-4 animate-spin text-accent shrink-0" /> : <Wrench className="size-4 text-muted shrink-0" />}
        <span className={cx("truncate flex-1", live ? "font-mono text-muted" : "text-[color-mix(in_oklab,var(--text)_80%,transparent)]")}>{summary}</span>
        {failed > 0 && <span className="text-xs text-danger shrink-0">{failed} 个失败</span>}
        {live && steps.length > 1 && <span className="text-xs text-muted shrink-0">{steps.length} 步</span>}
        <ChevronDown className={cx("size-4 text-muted transition shrink-0", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-line py-1">
          {steps.map((st) => (
            <StepRow key={st.id} step={st} />
          ))}
        </div>
      )}
    </div>
  );
}

export function UserBubble({ text, time }: { text: string; time?: string }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] bg-surface-2 rounded-xl px-4 py-2.5 whitespace-pre-wrap break-words text-[15px]">{text}</div>
      {time && <div className="text-[11px] text-muted mt-1">{time}</div>}
    </div>
  );
}

export function RunView({ run, approvals, onChanged }: { run: Run; approvals: Approval[]; onChanged: () => void }) {
  const { blocks, usage } = useMemo(() => {
    const { items, usage } = buildItems(run.events);
    return { blocks: groupSteps(items), usage };
  }, [run.events]);
  const finished = ["done", "failed", "cancelled"].includes(run.status);
  const pending = new Map(approvals.map((a) => [a.id, a]));
  const feedback = async (value: 1 | -1) => {
    try {
      await api.post(`/api/runs/${run.id}/feedback`, { value });
      toast(value === 1 ? "谢谢！会据此总结经验" : "已记录，会复盘这次的问题");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  return (
    <div className="space-y-3">
      <UserBubble text={run.prompt} time={clock(run.created_at)} />
      {blocks.map((it, i) => {
        switch (it.kind) {
          case "message":
            return it.user ? (
              <UserBubble key={it.id} text={it.text} />
            ) : (
              <div key={it.id} className="text-[16px]">
                <Markdown text={it.text} className="font-serif" />
                {it.streaming && !finished && <span className="inline-block size-2.5 ml-1 rounded-full bg-accent align-middle pulse-dot" />}
              </div>
            );
          case "steps":
            return <StepGroup key={it.id} steps={it.steps} live={!finished && i === blocks.length - 1} />;
          case "approval": {
            const a = pending.get(it.approvalId);
            if (a) return <ApprovalCard key={it.id} approval={a} showAgent={false} onResolved={onChanged} />;
            return (
              <div key={it.id} className="text-xs text-muted flex items-center gap-1.5">
                <CircleAlert className="size-3.5" /> 审批「{it.summary.slice(0, 40)}」{it.resolved === "approve" ? "已批准" : it.resolved === "deny" ? "已拒绝" : "已失效"}
              </div>
            );
          }
        }
      })}
      {!finished && !(run.status === "running" && blocks.at(-1)?.kind === "steps") && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {STATUS_TEXT[run.status]}…
        </div>
      )}
      {run.status === "failed" && (
        <div className="text-sm text-danger bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] rounded-lg px-3 py-2">任务失败：{run.error ?? "未知错误"}</div>
      )}
      {run.status === "cancelled" && <div className="text-xs text-muted">已停止{run.error ? `（${run.error}）` : ""}</div>}
      {finished && (
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <span className="flex-1">
            {run.model} · {tokens(usage.input || run.input_tokens)} 入 / {tokens(usage.output || run.output_tokens)} 出
          </span>
          <button aria-label="有帮助" onClick={() => feedback(1)} className={cx("p-1.5 rounded-md hover:bg-surface-2", run.feedback === 1 && "text-accent")}>
            <ThumbsUp className="size-4" />
          </button>
          <button aria-label="没帮助" onClick={() => feedback(-1)} className={cx("p-1.5 rounded-md hover:bg-surface-2", run.feedback === -1 && "text-danger")}>
            <ThumbsDown className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
