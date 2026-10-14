import { canTransition, isTerminal, type EngineProvider, type HubToRunner, type RunStatus, type RunnerEvent } from "@constella/protocol";
import { config, newId, nowIso } from "./config.ts";
import { audit, type Db } from "./db.ts";
import { decideApproval, type ApprovalMode } from "./safety.ts";
import type { EventStore } from "./events.ts";
import type { IncidentInput } from "./recovery.ts";

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
  /** Tool calls that completed successfully: the measure of "did this turn get anything done". */
  progress: number;
  /** How many times the supervisor stepped in while this run looked stuck, and when it looks next. */
  interventions: number;
  check_after: string | null;
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
  notify(title: string, body: string, url: string, kind: NotifyKind): void;
  /** Model reference ("model@provider") → the model name and provider the engine should use. Throws when unusable. */
  resolveModel?(ref: string): { model: string; provider: EngineProvider };
  /** Whether runs cut off by an agent / hub restart are continued automatically. */
  autoResume?(): boolean;
  /** Run length / stall limits and how many automatic continuations in a row to allow. */
  limits?(): RunLimits;
  /** How approval requests are decided: always ask, ask only for destructive actions, or approve all. */
  approvalMode?(): ApprovalMode;
  /** Bring back an agent whose runner can't be reached (recreate its container); resolves with what was done. */
  repairRunner?(agentId: string, error: string): Promise<string[]>;
  /** Record something that went wrong; unresolved ones are diagnosed and offered to the owner with options. */
  incident?(input: IncidentInput): void;
  /** Wait before the 1st, 2nd, 3rd automatic continuation without progress (tests pass zeros). */
  resumeDelaysMs?: number[];
}

export type NotifyKind = "done" | "failed" | "approval" | "stuck";

export interface RunLimits {
  /** A turn running longer than this is stopped and continued in a fresh one. */
  runTimeoutMinutes: number;
  /** A run with no sign of life for this long gets the supervisor's attention (0 = never). */
  runWatchdogMinutes: number;
  /**
   * Automatic continuations are unlimited while they get work done; this many in a row without a single
   * successful tool call means continuing again won't help, so the hub stops and files an incident.
   */
  maxAutoResumes: number;
}

const DEFAULT_LIMITS: RunLimits = { runTimeoutMinutes: config.runTimeoutMinutes, runWatchdogMinutes: config.runWatchdogMinutes, maxAutoResumes: 3 };

/** Prompt of a run started automatically to continue one that was cut off. */
export const RESUME_PREFIX = "［自动继续］";
/** Prompt of a run started because the owner adopted an option from an incident report. */
export const ADOPT_PREFIX = "［采用方案］";
/** Message carrying the owner's answer to a question the agent had stopped waiting for. */
export const ANSWER_PREFIX = "［主人的选择］";
export const resumeText = (why: string) => `${RESUME_PREFIX}上次任务因为${why}中断了，请从中断的地方继续完成。`;
const RESUME_DELAYS_MS = [3_000, 30_000, 120_000];
/** Engine failures worth retrying: crashes, dropped connections, rate limits, upstream 5xx. */
const TRANSIENT =
  /app-server exited|stream (disconnected|closed|error)|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|rate.?limit|too many requests|overloaded|temporarily|unavailable|bad gateway|\b(429|500|502|503|504|520|522|524)\b/i;

export function isTransientError(error: string | null | undefined): boolean {
  return !!error && TRANSIENT.test(error);
}

type FinishedHook = (run: RunRow) => void;

interface HubApproval {
  resolve: (r: { approved: boolean; answer?: string }) => void;
  runId: string;
}

export interface DecisionOption {
  label: string;
  detail?: string;
}

/** How a question to the owner ended: answered, dismissed ("decide yourself"), no answer in time, or the run ended. */
export type DecisionResult = { status: "answered"; answer: string } | { status: "dismissed" | "timeout" | "ended" };

interface ResumeRow {
  id: string;
  run_id: string;
  conversation_id: string;
  agent_id: string;
  text: string;
  reason: string;
  status: "scheduled" | "on_cancel" | "started" | "skipped";
  due_at: string | null;
}

export class RunManager {
  #d: RunDeps;
  #finishedHooks: FinishedHook[] = [];
  #hubApprovals = new Map<string, HubApproval>();
  /** Runs whose continuation finish() already arranged; the cut-off / failure paths leave them alone. */
  #continued = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #resumeTimer: NodeJS.Timeout | null = null;

  constructor(deps: RunDeps) {
    this.#d = deps;
  }

  #limits(): RunLimits {
    return this.#d.limits?.() ?? DEFAULT_LIMITS;
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
    if (input.model) this.#d.resolveModel?.(input.model);
    if (!conv) conv = this.createConversation(input.agentId, titleFrom(input.text), input.source ?? "user");
    if (input.model !== undefined || input.effort !== undefined) conv = this.setConversationModel(conv.id, input);

    const active = this.activeRun(conv.id);
    if (active && (active.status === "running" || active.status === "paused_by_user")) {
      this.#d.sendToRunner(input.agentId, { t: "steer", runId: active.id, text: input.text });
      this.#append(active, { type: "message.completed", runId: active.id, messageId: newId("um"), text: `［追加指示］${input.text}` });
      return { conversationId: conv.id, runId: active.id, steered: true };
    }
    if (active) {
      // The agent is waiting on a question: what the owner types is their answer.
      const question = this.#waitedDecision(active.id);
      if (!question) throw new Error("该对话正在等待审批，请先处理审批");
      this.#answerDecision(question, input.text, "user");
      return { conversationId: conv.id, runId: active.id, steered: true };
    }

    const payload = this.#d.startPayload(input.agentId);
    if (conv.model) payload.model = conv.model;
    if (conv.effort) payload.effort = conv.effort;
    const target = this.#d.resolveModel?.(payload.model);
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
      progress: 0,
      interventions: 0,
      check_after: null,
    };
    db.prepare(
      `INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, last_event_at, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(run.id, run.conversation_id, run.agent_id, run.prompt, run.model, run.last_event_at, run.created_at);
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(nowIso(), conv.id);
    this.#append(run, { type: "run.status", runId: run.id, status: "queued" });

    const convId = conv.id;
    const start = async () => {
      await this.#d.ensureRunner(input.agentId);
      const current = this.get(run.id);
      if (!current || isTerminal(current.status)) return;
      this.transition(run.id, "running");
      const ok = this.#d.sendToRunner(input.agentId, {
        t: "start",
        runId: run.id,
        conversationId: convId,
        // Read at send time: a repair or a "start over" option may have dropped the thread meanwhile.
        threadId: this.conversation(convId)?.thread_id ?? null,
        text: input.text,
        images: input.images,
        ...payload,
        ...(target ? { model: target.model, provider: target.provider } : {}),
      });
      if (!ok) throw new Error("runner not connected");
    };
    void start().catch((err) => this.#startFailed(run, errMessage(err), start));
    return { conversationId: conv.id, runId: run.id, steered: false };
  }

  /** The runner couldn't be reached: repair it (recreate the container) and try once more; otherwise continue later. */
  async #startFailed(run: RunRow, error: string, start: () => Promise<void>): Promise<void> {
    const { db } = this.#d;
    audit(db, "system", "runner.start_failed", { agentId: run.agent_id, runId: run.id, error });
    if (this.#d.repairRunner) {
      try {
        const steps = await this.#d.repairRunner(run.agent_id, error);
        const current = this.get(run.id);
        if (!current || isTerminal(current.status)) return;
        await start();
        audit(db, "system", "runner.repaired", { agentId: run.agent_id, runId: run.id, steps });
        this.notice(run.id, "recovery", `启动失败（${error}），已自动修复：${steps.join("；")}。任务继续。`);
        this.#d.incident?.({ kind: "start_failure", agentId: run.agent_id, conversationId: run.conversation_id, runId: run.id, error, actions: steps, resolved: true });
        return;
      } catch (err) {
        error = `${error}；自动修复后仍失败：${errMessage(err)}`;
        audit(db, "system", "runner.repair_failed", { agentId: run.agent_id, runId: run.id, error });
      }
    }
    if (!this.finish(run.id, "failed", `启动失败：${error}`, { notify: false })) return;
    if (this.#continued.delete(run.id)) return;
    // It never started, so the continuation has to carry the original request.
    this.#recover(run.id, `启动失败：${error}`, run.prompt.startsWith(RESUME_PREFIX) ? run.prompt : `${RESUME_PREFIX}${run.prompt}`);
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

  /** End a run. Returns false when it had already ended. `notify: false` when the caller reports the failure itself. */
  finish(runId: string, status: "done" | "failed" | "cancelled", error?: string, opts: { notify?: boolean } = {}): boolean {
    if (!this.transition(runId, status, error)) return false;
    const { db } = this.#d;
    // A continuation promised for when this run stops (watchdog split, supervisor restart).
    const onCancel = db.prepare("SELECT * FROM resumes WHERE run_id = ? AND status = 'on_cancel'").get(runId) as ResumeRow | undefined;
    if (onCancel) db.prepare("DELETE FROM resumes WHERE id = ?").run(onCancel.id);
    this.#d.events.forget(runId);
    for (const [id, a] of this.#hubApprovals) {
      if (a.runId === runId) {
        a.resolve({ approved: false });
        this.#hubApprovals.delete(id);
      }
    }
    // Open questions outlive the turn (an answer reaches the agent as a new message) unless the owner stopped it.
    db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE run_id = ? AND status = 'pending' AND (kind != 'decision' OR ? = 'cancelled')").run(
      nowIso(),
      runId,
      status,
    );
    const run = this.get(runId)!;
    const conv = this.conversation(run.conversation_id);
    const long = Date.now() - Date.parse(run.created_at) > 60_000;
    if (status === "failed" && opts.notify !== false) {
      this.#notifyFailed(run, error);
    } else if (status === "done" && (long || conv?.source !== "user")) {
      this.#d.notify(`${this.#agentName(run.agent_id)} 完成了任务`, run.prompt.slice(0, 100), `/c/${run.conversation_id}`, "done");
    }
    for (const hook of this.#finishedHooks) {
      try {
        hook(run);
      } catch (err) {
        console.error("finished hook failed", err);
      }
    }
    // However the stop landed (confirmed, timed out, or the runner went away), continue as promised.
    if (onCancel && status !== "done") {
      if (status === "failed") this.#continued.add(runId); // consumed by the failure path that called finish()
      this.#recover(runId, onCancel.reason, onCancel.text);
    }
    return true;
  }

  /** Called for every event a runner reports. */
  onRunnerEvent(agentId: string, ev: RunnerEvent): void {
    const run = this.get(ev.runId);
    if (!run || run.agent_id !== agentId || isTerminal(run.status)) return;
    const { db } = this.#d;
    db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ?").run(nowIso(), run.id);
    if (ev.type === "tool.started") db.prepare("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?").run(run.id);
    if (ev.type === "tool.completed" && ev.ok) db.prepare("UPDATE runs SET progress = progress + 1 WHERE id = ?").run(run.id);
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

  /** The engine is still working on a run (heartbeat): it isn't stuck, even without new events. */
  touch(agentId: string, runId: string): void {
    this.#d.db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ? AND agent_id = ? AND status = 'running'").run(nowIso(), runId, agentId);
  }

  /** A restart cut this run off: fail it, then continue it automatically when that's enabled. */
  cutOff(runId: string, error: string): void {
    if (!this.finish(runId, "failed", error, { notify: false })) return;
    if (this.#continued.delete(runId)) return;
    this.#recover(runId, error, resumeText("重启"));
  }

  /**
   * The engine reported the turn finished. Temporary failures (crash, network, rate limit) get continued;
   * anything else is filed as an incident, diagnosed, and offered to the owner with options.
   */
  engineDone(runId: string, status: "done" | "failed" | "cancelled", error?: string): void {
    if (status !== "failed") {
      this.finish(runId, status, error);
      return;
    }
    if (!this.finish(runId, "failed", error, { notify: false })) return;
    if (this.#continued.delete(runId)) return;
    if (isTransientError(error)) return this.#recover(runId, error ?? "临时故障", resumeText("临时故障"));
    const run = this.get(runId)!;
    if (!this.#d.incident) return this.#notifyFailed(run, error);
    this.#d.incident({ kind: "engine_error", agentId: run.agent_id, conversationId: run.conversation_id, runId, error: error ?? null });
  }

  /** Stop this turn and continue in a fresh one once the stop lands (watchdog split, supervisor restart). */
  async restart(runId: string, reason: string, text: string, actor: string): Promise<void> {
    const run = this.get(runId);
    if (!run || isTerminal(run.status)) return;
    const { db } = this.#d;
    // Already stopping for a restart (the watchdog ticks every minute until the stop lands).
    if (db.prepare("SELECT 1 FROM resumes WHERE run_id = ? AND status = 'on_cancel'").get(runId)) return;
    db.prepare("INSERT INTO resumes (id, run_id, conversation_id, agent_id, text, reason, status, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'on_cancel', NULL, ?)").run(
      newId("rs"),
      runId,
      run.conversation_id,
      run.agent_id,
      text,
      reason,
      nowIso(),
    );
    await this.interrupt(runId, actor);
  }

  /** Continue a run that ended abnormally, or tell the owner why not. */
  #recover(runId: string, reason: string, text: string): void {
    const run = this.get(runId);
    if (!run) return;
    if (!this.#d.autoResume?.()) return this.#notifyFailed(run, run.error ?? reason);
    const idle = this.idleStreak(run.conversation_id);
    if (idle >= this.#limits().maxAutoResumes) {
      // Continuing again won't help: stop, put it in the audit trail and let a diagnosis offer options.
      audit(this.#d.db, "system", "run.auto_resume_stalled", { runId, conversationId: run.conversation_id, attempts: idle, reason });
      if (!this.#d.incident) return this.#notifyFailed(run, run.error ?? reason);
      this.#d.incident({
        kind: "stalled",
        agentId: run.agent_id,
        conversationId: run.conversation_id,
        runId,
        error: run.error ?? reason,
        actions: [`连续自动继续 ${idle} 次都没有取得进展（没有一个工具调用成功），已暂停自动继续`],
      });
      return;
    }
    const delays = this.#d.resumeDelaysMs ?? RESUME_DELAYS_MS;
    this.#scheduleResume(run, text, reason, delays[Math.min(idle, delays.length - 1)] ?? 0);
  }

  /** How many of the latest runs in a row were automatic continuations that got nothing done. */
  idleStreak(conversationId: string): number {
    const rows = this.#d.db
      .prepare("SELECT prompt, progress FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20")
      .all(conversationId) as { prompt: string; progress: number }[];
    let n = 0;
    for (const r of rows) {
      if (r.progress > 0 || !r.prompt.startsWith(RESUME_PREFIX)) break;
      n++;
    }
    return n;
  }

  /** Persist a continuation; the resume poll starts it when due, so a hub restart in between doesn't lose it. */
  #scheduleResume(run: RunRow, text: string, reason: string, delayMs: number): void {
    const dueAt = new Date(Date.now() + delayMs).toISOString();
    this.#d.db
      .prepare("INSERT INTO resumes (id, run_id, conversation_id, agent_id, text, reason, status, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)")
      .run(newId("rs"), run.id, run.conversation_id, run.agent_id, text, reason.slice(0, 500), dueAt, nowIso());
    audit(this.#d.db, "system", "run.auto_resume", { runId: run.id, conversationId: run.conversation_id, reason: reason.slice(0, 300), dueAt });
    // Fast path; the poll started by startWatchdog() is what makes it durable.
    setTimeout(() => this.processResumes(), delayMs).unref?.();
  }

  /** Start every continuation that is due. Safe to call concurrently: each one is claimed before it starts. */
  processResumes(): void {
    const { db } = this.#d;
    const due = db.prepare("SELECT * FROM resumes WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at").all(nowIso()) as unknown as ResumeRow[];
    for (const r of due) {
      if (db.prepare("UPDATE resumes SET status = 'started' WHERE id = ? AND status = 'scheduled'").run(r.id).changes !== 1) continue;
      // The owner may have sent something meanwhile, or turned auto-resume off; don't stack a continuation on top.
      const latest = db.prepare("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(r.conversation_id) as
        | { id: string }
        | undefined;
      if (!this.#d.autoResume?.() || this.activeRun(r.conversation_id) || latest?.id !== r.run_id) {
        db.prepare("UPDATE resumes SET status = 'skipped' WHERE id = ?").run(r.id);
        continue;
      }
      void this.send({ agentId: r.agent_id, conversationId: r.conversation_id, text: r.text, source: "auto-resume" }).catch((err) =>
        console.error("auto-resume failed", r.run_id, err),
      );
    }
  }

  /** A line in the run's timeline about something the hub did on its own. */
  notice(runId: string, kind: "recovery" | "supervisor" | "incident", text: string, incidentId?: string): void {
    const run = this.get(runId);
    if (run) this.#append(run, { type: "system.notice", runId, kind, text, ...(incidentId ? { incidentId } : {}) });
  }

  /** Pass a hint to a running turn without it showing up as the owner's words (used by the supervisor). */
  hint(runId: string, text: string): boolean {
    const run = this.get(runId);
    if (!run || run.status !== "running") return false;
    return this.#d.sendToRunner(run.agent_id, { t: "steer", runId, text });
  }

  #notifyFailed(run: RunRow, error: string | null | undefined): void {
    this.#d.notify(`${this.#agentName(run.agent_id)} 任务失败`, (error ?? "").slice(0, 120) || run.prompt.slice(0, 80), `/c/${run.conversation_id}`, "failed");
  }

  #agentName(agentId: string): string {
    return (this.#d.db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as { name: string } | undefined)?.name ?? "agent";
  }

  async resolveApproval(approvalId: string, decision: "approve" | "deny", actor: string, by: "user" | "policy" = "user", answer?: string): Promise<void> {
    const { db } = this.#d;
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
    if (!row) throw new Error("approval not found");
    if (row.status !== "pending") throw new Error("该审批已处理");
    if (row.kind === "decision") {
      if (decision === "deny") {
        // Dismissed without an answer: the agent goes on with its own judgement.
        db.prepare("UPDATE approvals SET status = 'denied', resolved_at = ? WHERE id = ?").run(nowIso(), approvalId);
        audit(db, actor, "decision.dismiss", { approvalId });
        const run = this.get(row.run_id);
        if (run) this.#append(run, { type: "approval.resolved", runId: run.id, approvalId, decision: "deny", by });
        this.#hubApprovals.get(approvalId)?.resolve({ approved: false });
        this.#hubApprovals.delete(approvalId);
        this.#resumeIfNotWaiting(row.run_id);
        return;
      }
      return this.#answerDecision(row, answer ?? "", actor);
    }
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
      pending?.resolve({ approved: decision === "approve" });
    } else {
      this.#d.sendToRunner(row.agent_id, { t: "approval_decision", runId: row.run_id, approvalId, decision });
    }
    this.#resumeIfNotWaiting(row.run_id);
  }

  /** Back to running once nothing on this run is waiting for the owner any more. */
  #resumeIfNotWaiting(runId: string): void {
    const pending = this.#d.db.prepare("SELECT id, kind FROM approvals WHERE run_id = ? AND status = 'pending'").all(runId) as { id: string; kind: string }[];
    // A question the agent stopped waiting for (it went on with its recommendation) doesn't hold the run.
    if (!pending.some((p) => p.kind !== "decision" || this.#hubApprovals.has(p.id))) this.transition(runId, "running");
  }

  /** The question on this run the agent is still waiting on, if any. */
  #waitedDecision(runId: string): ApprovalRow | undefined {
    const rows = this.#d.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND kind = 'decision' AND status = 'pending' ORDER BY created_at DESC").all(runId) as unknown as ApprovalRow[];
    return rows.find((r) => this.#hubApprovals.has(r.id));
  }

  /**
   * A multiple-choice question from the agent ("ask_user"). Resolves with the owner's answer; "timeout" when
   * they haven't answered within `waitMs`. An unanswered question stays open: a later answer reaches the
   * agent as a new message.
   */
  requestDecision(runId: string, question: string, options: DecisionOption[], recommended: number | undefined, waitMs: number): Promise<DecisionResult> {
    const run = this.get(runId);
    if (!run || isTerminal(run.status)) return Promise.resolve({ status: "ended" });
    const approvalId = newId("ap");
    this.#d.db
      .prepare(
        "INSERT INTO approvals (id, run_id, agent_id, kind, summary, detail, status, created_at, source, options, recommended) VALUES (?, ?, ?, 'decision', ?, NULL, 'pending', ?, 'hub', ?, ?)",
      )
      .run(approvalId, runId, run.agent_id, question, nowIso(), JSON.stringify(options), recommended ?? null);
    this.#append(run, { type: "approval.requested", runId, approvalId, kind: "decision", summary: question, options, ...(recommended !== undefined ? { recommended } : {}) });
    const decided = new Promise<{ approved: boolean; answer?: string }>((resolve) => this.#hubApprovals.set(approvalId, { resolve, runId }));
    this.transition(runId, "waiting_approval");
    this.#d.notify(`${this.#agentName(run.agent_id)} 需要你选择`, question.slice(0, 140), `/c/${run.conversation_id}`, "approval");
    let timedOut = false;
    const timer = setTimeout(() => {
      const waiting = this.#hubApprovals.get(approvalId);
      if (!waiting) return;
      timedOut = true;
      this.#hubApprovals.delete(approvalId);
      waiting.resolve({ approved: false });
      this.#resumeIfNotWaiting(runId);
    }, waitMs);
    timer.unref?.();
    return decided.then((r): DecisionResult => {
      clearTimeout(timer);
      if (r.approved) return { status: "answered", answer: r.answer ?? "" };
      if (timedOut) return { status: "timeout" };
      const row = this.#d.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as { status: string } | undefined;
      return { status: row?.status === "denied" ? "dismissed" : "ended" };
    });
  }

  #answerDecision(row: ApprovalRow, answer: string, actor: string): void {
    const text = answer.trim();
    if (!text) throw new Error("请选择一个选项，或者直接写下你的回答");
    const { db } = this.#d;
    db.prepare("UPDATE approvals SET status = 'approved', answer = ?, resolved_at = ? WHERE id = ?").run(text, nowIso(), row.id);
    audit(db, actor, "decision.answer", { approvalId: row.id, answer: text.slice(0, 300) });
    const run = this.get(row.run_id);
    if (run) this.#append(run, { type: "approval.resolved", runId: run.id, approvalId: row.id, decision: "approve", by: "user", answer: text });
    const waiting = this.#hubApprovals.get(row.id);
    if (waiting) {
      this.#hubApprovals.delete(row.id);
      waiting.resolve({ approved: true, answer: text });
      this.#resumeIfNotWaiting(row.run_id);
      return;
    }
    // The agent stopped waiting and went on: hand the answer over as a message (a steer, or a new turn).
    if (!run) return;
    void this.send({ agentId: run.agent_id, conversationId: run.conversation_id, text: `${ANSWER_PREFIX}${row.summary}\n→ ${text}`, source: "decision" }).catch((err) =>
      console.error("deliver answer failed", row.id, err),
    );
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
    const decided = new Promise<boolean>((resolve) => this.#hubApprovals.set(approvalId, { resolve: (r) => resolve(r.approved), runId }));
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
    // Continuations live in the database; this poll starts them, including ones a restart interrupted.
    this.#resumeTimer = setInterval(() => this.processResumes(), 2_000);
    this.#resumeTimer.unref();
  }

  stopWatchdog(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#resumeTimer) clearInterval(this.#resumeTimer);
  }

  /** On boot: queued runs were never sent, so they are sent again (as a continuation carrying the request). */
  recoverOnBoot(): void {
    const rows = this.#d.db.prepare("SELECT id, prompt FROM runs WHERE status = 'queued'").all() as { id: string; prompt: string }[];
    for (const { id, prompt } of rows) {
      if (!this.finish(id, "failed", "hub 重启，任务未开始", { notify: false })) continue;
      this.#recover(id, "hub 重启，任务未开始", prompt.startsWith(RESUME_PREFIX) ? prompt : `${RESUME_PREFIX}${prompt}`);
    }
    // Running runs wait for their runner's hello (onRunnerHello); scheduled continuations are picked up by the poll.
  }

  #tick(): void {
    const rows = this.#d.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as unknown as RunRow[];
    const now = Date.now();
    const limits = this.#limits();
    for (const run of rows) {
      // Long tasks get split rather than dropped: stop this turn, then continue in a fresh one.
      if (now - Date.parse(run.created_at) > limits.runTimeoutMinutes * 60_000) {
        void this.restart(run.id, `单轮运行超过 ${limits.runTimeoutMinutes} 分钟`, resumeText(`单轮运行超过 ${limits.runTimeoutMinutes} 分钟`), "watchdog");
      }
    }
  }

  #notifyApproval(run: RunRow, summary: string): void {
    const agent = this.#d.db.prepare("SELECT name FROM agents WHERE id = ?").get(run.agent_id) as { name: string } | undefined;
    this.#d.notify(`${agent?.name ?? "agent"} 请求审批`, summary.slice(0, 140), `/c/${run.conversation_id}`, "approval");
  }

  #append(run: Pick<RunRow, "id" | "agent_id" | "conversation_id">, ev: RunnerEvent): void {
    this.#d.events.append(run.agent_id, run.conversation_id, ev);
  }
}

interface ApprovalRow {
  id: string;
  run_id: string;
  agent_id: string;
  kind: string;
  summary: string;
  status: string;
  source: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 30 ? `${t.slice(0, 30)}…` : t || "新对话";
}
