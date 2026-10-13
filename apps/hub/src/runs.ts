import { canTransition, isTerminal, type HubToRunner, type RunStatus, type RunnerEvent } from "@constella/protocol";
import { config, newId, nowIso } from "./config.ts";
import { audit, type Db } from "./db.ts";
import { decideApproval, type ApprovalMode } from "./safety.ts";
import type { EventStore } from "./events.ts";

export interface RunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  prompt: string;
  status: RunStatus;
  error: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  feedback: number | null;
  reflected: number;
  last_event_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ConversationRow {
  id: string;
  agent_id: string;
  title: string;
  thread_id: string | null;
  source: string;
  /** Overrides of the agent's model / reasoning effort for this conversation. */
  model: string | null;
  effort: Effort | null;
  created_at: string;
  updated_at: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh";

/** What the hub needs from the rest of the system to drive a run. */
export interface RunDeps {
  db: Db;
  events: EventStore;
  /** Make sure the agent's container is up and its runner connected. */
  ensureRunner(agentId: string): Promise<void>;
  sendToRunner(agentId: string, msg: HubToRunner): boolean;
  /** Payload pieces that depend on the agent's configuration and knowledge. */
  startPayload(agentId: string): {
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh";
    instructions: string;
    approvalPolicy: "auto" | "ask";
    skillRoots: string[];
  };
  notify(title: string, body: string, url?: string): void;
  /** Whether runs cut off by an agent / hub restart are continued automatically. */
  autoResume?(): boolean;
  /** How approval requests are decided: always ask, ask only for destructive actions, or approve all. */
  approvalMode?(): ApprovalMode;
  /** Wait before the 1st, 2nd, 3rd automatic continuation in a row (tests pass zeros). */
  resumeDelaysMs?: number[];
}

/** Prompt of a run started automatically to continue one that was cut off. */
export const RESUME_PREFIX = "［自动继续］";
const resumeText = (why: string) => `${RESUME_PREFIX}上次任务因为${why}中断了，请从中断的地方继续完成。`;
/** Give up after this many automatic continuations in a row that also got cut off. */
const MAX_AUTO_RESUMES = 3;
const RESUME_DELAYS_MS = [3_000, 30_000, 120_000];
/** Engine failures worth retrying: crashes, dropped connections, rate limits, upstream 5xx. */
const TRANSIENT =
  /app-server exited|stream (disconnected|closed|error)|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|rate.?limit|too many requests|overloaded|temporarily|unavailable|bad gateway|\b(429|500|502|503|504|520|522|524)\b/i;

export function isTransientError(error: string | null | undefined): boolean {
  return !!error && TRANSIENT.test(error);
}

type FinishedHook = (run: RunRow) => void;

interface HubApproval {
  resolve: (approved: boolean) => void;
  runId: string;
}

export class RunManager {
  #d: RunDeps;
  #finishedHooks: FinishedHook[] = [];
  #hubApprovals = new Map<string, HubApproval>();
  /** Runs the watchdog stopped for running too long; continued once the stop lands. */
  #resumeOnCancel = new Set<string>();
  #watchdogNotified = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: RunDeps) {
    this.#d = deps;
  }

  onFinished(hook: FinishedHook): void {
    this.#finishedHooks.push(hook);
  }

  get(runId: string): RunRow | undefined {
    return this.#d.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  }

  conversation(id: string): ConversationRow | undefined {
    return this.#d.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
  }

  setConversationModel(id: string, patch: { model?: string | null; effort?: Effort | null }): ConversationRow {
    if (patch.model !== undefined) this.#d.db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(patch.model, id);
    if (patch.effort !== undefined) this.#d.db.prepare("UPDATE conversations SET effort = ? WHERE id = ?").run(patch.effort, id);
    return this.conversation(id)!;
  }

  activeRun(conversationId: string): RunRow | undefined {
    return this.#d.db
      .prepare(
        "SELECT * FROM runs WHERE conversation_id = ? AND status NOT IN ('done','failed','cancelled') ORDER BY created_at DESC LIMIT 1",
      )
      .get(conversationId) as RunRow | undefined;
  }

  createConversation(agentId: string, title: string, source = "user"): ConversationRow {
    const now = nowIso();
    const conv: ConversationRow = { id: newId("cv"), agent_id: agentId, title, thread_id: null, source, model: null, effort: null, created_at: now, updated_at: now };
    this.#d.db
      .prepare("INSERT INTO conversations (id, agent_id, title, thread_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(conv.id, conv.agent_id, conv.title, null, conv.source, now, now);
    return conv;
  }

  /**
   * Send a message to an agent. If the conversation already has a run in progress the text
   * is delivered as a steer (mid-run instruction) instead of starting a new turn.
   */
  async send(input: {
    agentId: string;
    conversationId?: string | null;
    text: string;
    images?: string[];
    source?: string;
    /** Switch this conversation's model / effort (null = back to the agent's) before sending. */
    model?: string | null;
    effort?: Effort | null;
  }): Promise<{ conversationId: string; runId: string; steered: boolean }> {
    const { db } = this.#d;
    let conv = input.conversationId ? this.conversation(input.conversationId) : undefined;
    if (input.conversationId && !conv) throw new Error("conversation not found");
    if (conv && conv.agent_id !== input.agentId) throw new Error("conversation belongs to another agent");
    if (!conv) conv = this.createConversation(input.agentId, titleFrom(input.text), input.source ?? "user");
    if (input.model !== undefined || input.effort !== undefined) conv = this.setConversationModel(conv.id, input);

    const active = this.activeRun(conv.id);
    if (active && (active.status === "running" || active.status === "paused_by_user")) {
      this.#d.sendToRunner(input.agentId, { t: "steer", runId: active.id, text: input.text });
      this.#append(active, { type: "message.completed", runId: active.id, messageId: newId("um"), text: `［追加指示］${input.text}` });
      return { conversationId: conv.id, runId: active.id, steered: true };
    }
    if (active) throw new Error("该对话正在等待审批，请先处理审批");

    const payload = this.#d.startPayload(input.agentId);
    if (conv.model) payload.model = conv.model;
    if (conv.effort) payload.effort = conv.effort;
    const run: RunRow = {
      id: newId("run"),
      conversation_id: conv.id,
      agent_id: input.agentId,
      prompt: input.text,
      status: "queued",
      error: null,
      model: payload.model,
      input_tokens: 0,
      output_tokens: 0,
      tool_calls: 0,
      feedback: null,
      reflected: 0,
      last_event_at: nowIso(),
      created_at: nowIso(),
      finished_at: null,
    };
    db.prepare(
      `INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, last_event_at, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(run.id, run.conversation_id, run.agent_id, run.prompt, run.model, run.last_event_at, run.created_at);
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(nowIso(), conv.id);
    this.#append(run, { type: "run.status", runId: run.id, status: "queued" });

    const convId = conv.id;
    const threadId = conv.thread_id;
    void (async () => {
      try {
        await this.#d.ensureRunner(input.agentId);
        const current = this.get(run.id);
        if (!current || isTerminal(current.status)) return;
        this.transition(run.id, "running");
        const ok = this.#d.sendToRunner(input.agentId, {
          t: "start",
          runId: run.id,
          conversationId: convId,
          threadId,
          text: input.text,
          images: input.images,
          ...payload,
        });
        if (!ok) throw new Error("runner not connected");
      } catch (err) {
        this.finish(run.id, "failed", `启动失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return { conversationId: conv.id, runId: run.id, steered: false };
  }

  transition(runId: string, to: RunStatus, error?: string): boolean {
    const run = this.get(runId);
    if (!run || run.status === to) return false;
    if (!canTransition(run.status, to)) return false;
    this.#d.db
      .prepare("UPDATE runs SET status = ?, error = COALESCE(?, error), finished_at = ? WHERE id = ?")
      .run(to, error ?? null, isTerminal(to) ? nowIso() : null, runId);
    this.#append(run, { type: "run.status", runId, status: to, ...(error ? { error } : {}) });
    return true;
  }

  finish(runId: string, status: "done" | "failed" | "cancelled", error?: string): void {
    if (!this.transition(runId, status, error)) return;
    if (this.#resumeOnCancel.delete(runId)) this.#maybeResume(runId, resumeText(`单轮运行超过 ${config.runTimeoutMinutes} 分钟`));
    this.#watchdogNotified.delete(runId);
    this.#d.events.forget(runId);
    for (const [id, a] of this.#hubApprovals) {
      if (a.runId === runId) {
        a.resolve(false);
        this.#hubApprovals.delete(id);
      }
    }
    this.#d.db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE run_id = ? AND status = 'pending'").run(nowIso(), runId);
    const run = this.get(runId)!;
    const conv = this.conversation(run.conversation_id);
    const agent = this.#d.db.prepare("SELECT name FROM agents WHERE id = ?").get(run.agent_id) as { name: string } | undefined;
    const long = Date.now() - Date.parse(run.created_at) > 60_000;
    if (status === "failed") {
      this.#d.notify(`${agent?.name ?? "agent"} 任务失败`, (error ?? "").slice(0, 120) || run.prompt.slice(0, 80), `/c/${run.conversation_id}`);
    } else if (status === "done" && (long || conv?.source !== "user")) {
      this.#d.notify(`${agent?.name ?? "agent"} 完成了任务`, run.prompt.slice(0, 100), `/c/${run.conversation_id}`);
    }
    for (const hook of this.#finishedHooks) {
      try {
        hook(run);
      } catch (err) {
        console.error("finished hook failed", err);
      }
    }
  }

  /** Called for every event a runner reports. */
  onRunnerEvent(agentId: string, ev: RunnerEvent): void {
    const run = this.get(ev.runId);
    if (!run || run.agent_id !== agentId || isTerminal(run.status)) return;
    const { db } = this.#d;
    db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ?").run(nowIso(), run.id);
    this.#watchdogNotified.delete(run.id);
    if (ev.type === "tool.started") db.prepare("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?").run(run.id);
    if (ev.type === "usage") {
      db.prepare("UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?").run(
        ev.inputTokens,
        ev.outputTokens,
        run.id,
      );
    }
    this.#append(run, ev);
    if (ev.type === "approval.requested") {
      db.prepare(
        "INSERT INTO approvals (id, run_id, agent_id, kind, summary, detail, status, created_at, source) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'engine')",
      ).run(ev.approvalId, run.id, agentId, ev.kind, ev.summary, ev.detail ?? null, nowIso());
      const { approve, why } = decideApproval(this.#d.approvalMode?.() ?? "ask", ev.kind, ev.summary);
      if (approve) {
        void this.resolveApproval(ev.approvalId, "approve", "policy", "policy");
        return;
      }
      this.transition(run.id, "waiting_approval");
      this.#notifyApproval(run, why ? `${why}：${ev.summary}` : ev.summary);
    }
  }

  onThread(agentId: string, runId: string, threadId: string): void {
    const run = this.get(runId);
    if (!run || run.agent_id !== agentId) return;
    this.#d.db.prepare("UPDATE conversations SET thread_id = ? WHERE id = ?").run(threadId, run.conversation_id);
  }

  /** Runner (re)connected: runs it no longer knows about can never finish. */
  onRunnerHello(agentId: string, activeRuns: string[]): void {
    const rows = this.#d.db
      .prepare("SELECT id FROM runs WHERE agent_id = ? AND status IN ('running','waiting_approval','paused_by_user')")
      .all(agentId) as { id: string }[];
    for (const { id } of rows) if (!activeRuns.includes(id)) this.cutOff(id, "agent 进程重启，任务中断");
  }

  /** A restart cut this run off: fail it, then continue it automatically when that's enabled. */
  cutOff(runId: string, error: string): void {
    this.finish(runId, "failed", error);
    this.#maybeResume(runId, resumeText("重启"));
  }

  /** The engine reported the turn finished; temporary failures (crash, network, rate limit) get continued. */
  engineDone(runId: string, status: "done" | "failed" | "cancelled", error?: string): void {
    this.finish(runId, status, error);
    if (status === "failed" && isTransientError(error)) this.#maybeResume(runId, resumeText("临时故障"));
  }

  /** Continue a cut-off run in the same conversation (the engine thread keeps the context), backing off each time. */
  #maybeResume(runId: string, text: string): void {
    if (!this.#d.autoResume?.()) return;
    const run = this.get(runId);
    if (!run) return;
    // How many automatic continuations in a row led here; stop once they keep getting cut off.
    const recent = this.#d.db
      .prepare("SELECT prompt FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(run.conversation_id, MAX_AUTO_RESUMES) as { prompt: string }[];
    let streak = 0;
    while (streak < recent.length && recent[streak]!.prompt.startsWith(RESUME_PREFIX)) streak++;
    if (streak >= MAX_AUTO_RESUMES) return;
    const delays = this.#d.resumeDelaysMs ?? RESUME_DELAYS_MS;
    setTimeout(() => {
      // The user may have sent something meanwhile; don't stack a continuation on top of it.
      if (this.activeRun(run.conversation_id)) return;
      const latest = this.#d.db.prepare("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1").get(run.conversation_id) as { id: string };
      if (latest.id !== runId) return;
      void this.send({ agentId: run.agent_id, conversationId: run.conversation_id, text, source: "auto-resume" }).catch((err) =>
        console.error("auto-resume failed", runId, err),
      );
    }, delays[Math.min(streak, delays.length - 1)] ?? 0).unref?.();
  }

  async resolveApproval(approvalId: string, decision: "approve" | "deny", actor: string, by: "user" | "policy" = "user"): Promise<void> {
    const { db } = this.#d;
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
      | { id: string; run_id: string; agent_id: string; status: string; source: string }
      | undefined;
    if (!row) throw new Error("approval not found");
    if (row.status !== "pending") throw new Error("该审批已处理");
    db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(
      decision === "approve" ? "approved" : "denied",
      nowIso(),
      approvalId,
    );
    audit(db, actor, `approval.${decision}`, { approvalId });
    const run = this.get(row.run_id);
    if (run) this.#append(run, { type: "approval.resolved", runId: run.id, approvalId, decision, by });
    if (row.source === "hub") {
      const pending = this.#hubApprovals.get(approvalId);
      this.#hubApprovals.delete(approvalId);
      pending?.resolve(decision === "approve");
    } else {
      this.#d.sendToRunner(row.agent_id, { t: "approval_decision", runId: row.run_id, approvalId, decision });
    }
    const stillPending = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND status = 'pending'").get(row.run_id) as {
      n: number;
    };
    if (stillPending.n === 0) this.transition(row.run_id, "running");
  }

  /** Approval raised by a hub-side tool (e.g. host_exec); resolves when the user decides. */
  requestHubApproval(runId: string, kind: "host_access" | "desktop" | "other", summary: string, detail?: string): Promise<boolean> {
    const run = this.get(runId);
    if (!run || isTerminal(run.status)) return Promise.resolve(false);
    const approvalId = newId("ap");
    this.#d.db
      .prepare(
        "INSERT INTO approvals (id, run_id, agent_id, kind, summary, detail, status, created_at, source) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'hub')",
      )
      .run(approvalId, runId, run.agent_id, kind, summary, detail ?? null, nowIso());
    this.#append(run, { type: "approval.requested", runId, approvalId, kind, summary, detail });
    const decided = new Promise<boolean>((resolve) => this.#hubApprovals.set(approvalId, { resolve, runId }));
    const { approve, why } = decideApproval(this.#d.approvalMode?.() ?? "ask", kind, summary);
    if (approve) {
      void this.resolveApproval(approvalId, "approve", "policy", "policy");
      return decided;
    }
    this.transition(runId, "waiting_approval");
    this.#notifyApproval(run, why ? `${why}：${summary}` : summary);
    return decided;
  }

  async interrupt(runId: string, actor: string): Promise<void> {
    const run = this.get(runId);
    if (!run || isTerminal(run.status)) return;
    audit(this.#d.db, actor, "run.interrupt", { runId });
    if (run.status === "queued" || !this.#d.sendToRunner(run.agent_id, { t: "interrupt", runId })) {
      this.finish(runId, "cancelled");
      return;
    }
    // If the engine doesn't confirm in time, cancel on our side.
    setTimeout(() => {
      const r = this.get(runId);
      if (r && !isTerminal(r.status)) this.finish(runId, "cancelled", "停止超时，已强制结束");
    }, 20_000).unref();
  }

  setFeedback(runId: string, feedback: 1 | -1): RunRow | undefined {
    this.#d.db.prepare("UPDATE runs SET feedback = ? WHERE id = ?").run(feedback, runId);
    return this.get(runId);
  }

  /** Append an event for a run (used by the hub itself, e.g. desktop actions). */
  appendFor(runId: string, ev: RunnerEvent): void {
    const run = this.get(runId);
    if (run) this.#append(run, ev);
  }

  startWatchdog(): void {
    this.#timer = setInterval(() => this.#tick(), 60_000);
    this.#timer.unref();
  }

  stopWatchdog(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** On boot: queued runs were never sent; they can't be resumed reliably. */
  recoverOnBoot(): void {
    const rows = this.#d.db.prepare("SELECT id, prompt FROM runs WHERE status = 'queued'").all() as { id: string; prompt: string }[];
    for (const { id, prompt } of rows) {
      this.finish(id, "failed", "hub 重启，任务未开始");
      // It never started, so send the original request again rather than "continue".
      setTimeout(() => this.#maybeResume(id, prompt.startsWith(RESUME_PREFIX) ? prompt : `${RESUME_PREFIX}${prompt}`), 1000);
    }
    // Running runs wait for their runner's hello (onRunnerHello) or the watchdog.
  }

  #tick(): void {
    const { db } = this.#d;
    const rows = db.prepare("SELECT * FROM runs WHERE status IN ('running','queued')").all() as unknown as RunRow[];
    const now = Date.now();
    for (const run of rows) {
      const idle = now - Date.parse(run.last_event_at ?? run.created_at);
      const age = now - Date.parse(run.created_at);
      if (age > config.runTimeoutMinutes * 60_000) {
        // Long tasks get split rather than dropped: stop this turn, then continue in a fresh one.
        this.#resumeOnCancel.add(run.id);
        void this.interrupt(run.id, "watchdog");
        continue;
      }
      if (idle > config.runWatchdogMinutes * 60_000 && !this.#watchdogNotified.has(run.id)) {
        this.#watchdogNotified.add(run.id);
        this.#d.notify("任务可能卡住了", `已 ${Math.round(idle / 60_000)} 分钟没有进展：${run.prompt.slice(0, 60)}`, `/c/${run.conversation_id}`);
      }
    }
  }

  #notifyApproval(run: RunRow, summary: string): void {
    const agent = this.#d.db.prepare("SELECT name FROM agents WHERE id = ?").get(run.agent_id) as { name: string } | undefined;
    this.#d.notify(`${agent?.name ?? "agent"} 请求审批`, summary.slice(0, 140), `/c/${run.conversation_id}`);
  }

  #append(run: Pick<RunRow, "id" | "agent_id" | "conversation_id">, ev: RunnerEvent): void {
    this.#d.events.append(run.agent_id, run.conversation_id, ev);
  }
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 30 ? `${t.slice(0, 30)}…` : t || "新对话";
}
