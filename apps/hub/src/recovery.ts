import type { AgentEvent } from "@constella/protocol";
import { z } from "zod";
import type { Agents } from "./agents.ts";
import { config, newId, nowIso } from "./config.ts";
import type { Containers } from "./containers.ts";
import { audit, type Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import { transcriptFor } from "./learning.ts";
import type { ModelRegistry } from "./models.ts";
import { ADOPT_PREFIX, resumeText, type NotifyKind, type RunLimits, type RunManager, type RunRow } from "./runs.ts";
import { redact } from "./secrets.ts";

/**
 * Self-maintenance with rules. Everything the hub does on its own goes through here and is recorded:
 * - repairing an agent whose runner can't be reached (recreate its container);
 * - incidents: failures the hub can't fix itself get a model-written diagnosis with options the owner
 *   adopts in one click (each option is one of a fixed set of actions);
 * - the supervisor: a separate model that looks at runs which stopped making progress and picks one of a
 *   few bounded actions (wait, stop a stuck process, hint, restart the turn, ask the owner).
 */

export type IncidentKind = "start_failure" | "engine_error" | "stalled" | "stuck";
export type IncidentStatus = "analyzing" | "open" | "auto" | "adopted" | "dismissed";

/** What an option does when adopted. Diagnoses offer the first four; stuck-run questions the last three (and continue). */
const ACTIONS = ["continue", "switch_model", "restart_agent", "new_thread", "wait", "restart", "stop"] as const;
const DIAGNOSIS_ACTIONS = new Set<string>(["continue", "switch_model", "restart_agent", "new_thread"]);
const STUCK_ACTIONS = new Set<string>(["continue", "wait", "restart", "stop"]);

export const IncidentOption = z.object({
  title: z.string().trim().min(1).max(40),
  detail: z.string().trim().max(300).default(""),
  action: z.enum(ACTIONS),
  model: z.string().trim().max(200).optional(),
  text: z.string().trim().max(3000).default(""),
});
export type IncidentOption = z.infer<typeof IncidentOption>;

export interface IncidentInput {
  kind: IncidentKind;
  agentId: string;
  conversationId: string | null;
  runId: string | null;
  error?: string | null;
  /** What the hub already did about it. */
  actions?: string[];
  /** The hub handled it; the record is for the audit trail. */
  resolved?: boolean;
  /** Known up front (supervisor questions); otherwise a diagnosis writes them. */
  title?: string;
  summary?: string;
  options?: IncidentOption[];
  recommended?: number;
}

export interface Incident {
  id: string;
  kind: IncidentKind;
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  title: string;
  summary: string;
  error: string | null;
  actions: string[];
  options: IncidentOption[];
  recommended: number | null;
  status: IncidentStatus;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

const DEFAULT_TITLE: Record<IncidentKind, string> = {
  start_failure: "任务启动失败",
  engine_error: "任务出错停下了",
  stalled: "自动继续没有进展，已暂停",
  stuck: "任务卡住了",
};

/** Supervisor: after this many interventions on one run the owner decides. */
export const MAX_INTERVENTIONS = 3;
/** Prompts of the continuations after the supervisor restarted a turn / rebuilt the container (how the ladder knows where it is). */
const AFTER_RESTART = resumeText("卡住（监督员重启了这一轮）");
const AFTER_REBUILD = resumeText("卡住（监督员重建了 agent 容器）");
/** Tools that legitimately wait on the owner; a run inside one isn't stuck. */
const WAITING_ON_OWNER = new Set(["constella.desktop_request_help", "constella.ask_user"]);

const DIAGNOSE_SYSTEM = `你是 Constella 平台的"诊断员"。某个 agent 的任务出错停下了，系统没法自动处理。请根据材料写一份简短的诊断报告，并给出主人可以一键采用的方案。
只输出一个 JSON 对象：
{"title":"不超过 24 字的标题","cause":"原因分析，2-4 句：哪里出错、为什么、证据是什么","options":[{"title":"不超过 14 字","detail":"一句话：这个方案做什么、适合什么情况","action":"continue|switch_model|restart_agent|new_thread","model":"仅 switch_model 填，必须从可用模型里选","text":"采用后作为新消息发给 agent 的指示"}],"recommended":0}
方案动作只能是：
- continue：在原对话里发一条指示让 agent 继续，例如换一种做法、跳过出错的步骤、分批处理、先修好环境再继续。
- switch_model：把这个对话换成另一个可用模型后继续（模型报错、不支持某功能、能力不够时）。
- restart_agent：重建 agent 的容器（文件和记忆都保留）后继续（容器环境坏了、进程异常、内存或磁盘出问题时）。
- new_thread：清空这个对话的引擎上下文后重新开始（上下文超长、会话损坏时）；text 里写清楚任务目标、已经完成的部分和下一步。
规则：
- 给 2-4 个方案，按推荐程度排序；recommended 是最推荐方案的序号（从 0 开始）。
- 方案必须基于材料里的证据，具体可执行，不要编造。
- text 用中文，直接对 agent 说要怎么做。text 里要用主人的原话写明要完成的任务（见「主人的请求」），不要根据 agent 的名字或猜测编造任务内容。
- 换模型、重建容器、清空上下文都由系统在采用时完成，text 里不要再让 agent 去做这些，只说明已经做了什么、接下来要完成什么。`;

const SUPERVISE_SYSTEM = `你是 Constella 平台的"监督员"。你从外部观察一个 agent 的任务，它已经很久没有任何进展（没有输出、没有新步骤）。
你会看到：任务、正在执行还没返回的工具调用和它的输出尾部、最近的步骤、agent 容器里的进程列表。判断原因，从下面选一个动作，只输出一个 JSON 对象：
{"assessment":"一两句话：现在是什么情况、依据是什么","action":"wait|kill|hint|restart|rebuild|escalate","minutes":15,"pids":[123],"text":"…","options":[]}
- wait：确实在正常干活（下载、编译、训练等，相关进程在占用 CPU 或明显在推进），再等 minutes 分钟（5-60）。
- kill：某个命令卡死了（在等交互输入、死锁、连不上的网络请求、在前台常驻的服务进程），结束它，agent 会看到命令失败并换办法继续。pids 只能填进程列表里由这个命令产生的进程；text 写一句给 agent 的说明，比如应该改用非交互参数或放到后台运行。
- hint：agent 没在执行命令，却在原地打转或在等什么；text 写一条具体的提示告诉它怎么继续。
- restart：引擎本身没反应（没有正在执行的工具，codex 进程也没有 CPU 活动），停止这一轮，然后在原对话里自动继续。
- rebuild：codex 进程本身卡死（状态为 T 或 D、长时间没有 CPU 活动）或者整个容器环境坏了，重建 agent 容器（文件和记忆保留），然后在原对话里自动继续。
- escalate：只有继续推进必须由主人本人决定、或贸然行动可能造成损失时才用。options 给 2-3 个选项：{"title":"不超过 14 字","detail":"一句话","action":"wait|restart|stop|continue","text":"action=continue 时发给 agent 的指示"}。
原则：尽量让任务自己推进下去，少打扰主人；不确定是否在正常干活时，先 wait 一次。`;

const Diagnosis = z.object({
  title: z.string().trim().min(1).max(60),
  cause: z.string().trim().min(1).max(1000),
  options: z.array(z.unknown()).max(8),
  recommended: z.number().int().min(0).optional(),
});

const Verdict = z.object({
  assessment: z.string().trim().min(1).max(600),
  action: z.enum(["wait", "kill", "hint", "restart", "rebuild", "escalate"]),
  minutes: z.number().optional(),
  pids: z.array(z.number().int()).max(20).optional(),
  text: z.string().trim().max(1500).optional(),
  options: z.array(z.unknown()).max(6).optional(),
});
export type Verdict = z.infer<typeof Verdict>;

/** Keep the options that are well-formed and allowed here; a switch must name another model that exists. */
export function cleanOptions(raw: unknown[], allowed: Set<string>, models: string[], currentModel: string): IncidentOption[] {
  const out: IncidentOption[] = [];
  for (const r of raw) {
    const p = IncidentOption.safeParse(r);
    if (!p.success || !allowed.has(p.data.action)) continue;
    if (p.data.action === "switch_model" && (!p.data.model || !models.includes(p.data.model) || p.data.model === currentModel)) continue;
    out.push(p.data);
  }
  return out.slice(0, 4);
}

/** A model's diagnosis, validated; null when it isn't usable. */
export function parseDiagnosis(raw: unknown, models: string[], currentModel: string): { title: string; summary: string; options: IncidentOption[]; recommended: number } | null {
  const p = Diagnosis.safeParse(raw);
  if (!p.success) return null;
  const options = cleanOptions(p.data.options, DIAGNOSIS_ACTIONS, models, currentModel);
  if (!options.length) return null;
  const rec = p.data.recommended ?? 0;
  return { title: p.data.title, summary: p.data.cause, options, recommended: rec < options.length ? rec : 0 };
}

export function parseVerdict(raw: unknown): Verdict | null {
  const p = Verdict.safeParse(raw);
  return p.success ? p.data : null;
}

export interface Proc {
  pid: number;
  ppid: number;
  seconds: number;
  stat: string;
  cpu: number;
  args: string;
}

/** `ps -eo pid,ppid,etimes,stat,pcpu,args` → rows. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1]!, ppid: +m[2]!, seconds: +m[3]!, stat: m[4]!, cpu: +m[5]!, args: m[6]! });
  }
  return out;
}

const PROTECTED = /codex|\/opt\/constella\/runner|^ps\b/;

/**
 * Which of the requested pids may be stopped: only commands the engine started (descendants of a codex
 * process), never the runner, the engine itself or pid 1.
 */
export function killable(procs: Proc[], requested: number[]): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const fromEngine = (p: Proc): boolean => {
    for (let cur = byPid.get(p.ppid), hops = 0; cur && hops < 50; cur = byPid.get(cur.ppid), hops++) {
      if (/codex/.test(cur.args)) return true;
    }
    return false;
  };
  return [...new Set(requested)].filter((pid) => {
    const p = byPid.get(pid);
    return !!p && pid !== 1 && !PROTECTED.test(p.args) && fromEngine(p);
  });
}

export interface RecoveryDeps {
  db: Db;
  events: EventStore;
  runs: RunManager;
  agents: Agents;
  containers: Containers;
  /** Models for diagnoses and the supervisor: the configured ones, and a JSON chat on the chosen one. */
  llm: Pick<ModelRegistry, "chatJson" | "list">;
  /** Model for diagnoses and the supervisor (the reflection model). */
  model(): string;
  notify(title: string, body: string, url: string, kind: NotifyKind): void;
  /** A run with no sign of life for `runWatchdogMinutes` gets the supervisor (0 = never). */
  limits?(): Pick<RunLimits, "runWatchdogMinutes">;
  /** Make sure the agent's container is up and its runner connected. */
  ensureRunner(agentId: string): Promise<void>;
  /** Whether the agent's runner is connected right now. */
  connected(agentId: string): boolean;
  secretValues(): string[];
}

export class Recovery {
  #d: RecoveryDeps;
  #repairs = new Map<string, Promise<string[]>>();
  #supervising = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  /** When the supervisor started; time the hub was down doesn't count as a run being idle. */
  #startedAt = 0;

  constructor(deps: RecoveryDeps) {
    this.#d = deps;
    // Later work in the same conversation settles what an incident was about.
    deps.runs.onFinished((run) => this.#settle(run));
  }

  // ── incidents ────────────────────────────────────────────

  file(input: IncidentInput): Incident {
    const { db } = this.#d;
    const id = newId("inc");
    const status: IncidentStatus = input.resolved ? "auto" : input.options?.length ? "open" : "analyzing";
    const title = input.title ?? DEFAULT_TITLE[input.kind];
    const summary = input.summary ?? (input.resolved ? (input.actions ?? []).join("；") : "正在分析原因…");
    db.prepare(
      `INSERT INTO incidents (id, kind, agent_id, conversation_id, run_id, title, summary, error, actions, options, recommended, status, resolution, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.agentId,
      input.conversationId,
      input.runId,
      title,
      summary,
      input.error ? this.#redact(input.error).slice(0, 4000) : null,
      JSON.stringify(input.actions ?? []),
      JSON.stringify(input.options ?? []),
      input.recommended ?? null,
      status,
      input.resolved ? "自动处理" : null,
      nowIso(),
      input.resolved ? nowIso() : null,
    );
    audit(db, "system", `incident.${input.kind}`, { id, runId: input.runId, status, error: input.error?.slice(0, 300) });
    if (input.runId && !input.resolved) this.#d.runs.notice(input.runId, "incident", title, id);
    this.#publish(id);
    if (status === "analyzing") void this.diagnose(id).catch((err) => console.error("diagnose failed", id, err));
    else if (status === "open") this.#notifyOpen(this.get(id)!);
    return this.get(id)!;
  }

  get(id: string): Incident | undefined {
    const row = this.#d.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Record<string, any> | undefined;
    return row ? toIncident(row) : undefined;
  }

  list(filter: { status?: "open" | "all"; conversationId?: string; limit?: number } = {}): Incident[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status === "open") where.push("status IN ('open','analyzing')");
    if (filter.conversationId) {
      where.push("conversation_id = ?");
      args.push(filter.conversationId);
    }
    const rows = this.#d.db
      .prepare(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, Math.min(filter.limit ?? 100, 500)) as Record<string, any>[];
    return rows.map(toIncident);
  }

  /** Ask the diagnosis model what went wrong and what the owner could do; generic options when it can't answer. */
  async diagnose(id: string): Promise<Incident | undefined> {
    const inc = this.get(id);
    if (!inc) return undefined;
    const agent = inc.agent_id ? this.#agent(inc.agent_id) : undefined;
    const conv = inc.conversation_id ? this.#d.runs.conversation(inc.conversation_id) : undefined;
    const currentModel = conv?.model ?? agent?.model ?? "";
    const models = this.#d.llm.list().map((m) => m.ref);
    let result: { title: string; summary: string; options: IncidentOption[]; recommended: number };
    try {
      const raw = await this.#d.llm.chatJson(this.#d.model(), DIAGNOSE_SYSTEM, await this.#materials(inc, models, currentModel));
      result = parseDiagnosis(raw, models, currentModel) ?? this.#fallback(inc, models, currentModel, "诊断模型的回答格式不对");
    } catch (err) {
      result = this.#fallback(inc, models, currentModel, `诊断模型暂时不可用：${errMessage(err).slice(0, 120)}`);
    }
    this.#d.db
      .prepare("UPDATE incidents SET title = ?, summary = ?, options = ?, recommended = ?, status = 'open' WHERE id = ? AND status = 'analyzing'")
      .run(result.title, result.summary, JSON.stringify(result.options), result.recommended, id);
    audit(this.#d.db, "system", "incident.diagnosed", { id, title: result.title, options: result.options.map((o) => o.title) });
    this.#publish(id);
    const done = this.get(id)!;
    if (done.status === "open") this.#notifyOpen(done);
    return done;
  }

  /** Carry out the option the owner picked. */
  async adopt(id: string, index: number, actor: string): Promise<Incident> {
    const inc = this.get(id);
    if (!inc) throw new Error("报告不存在");
    if (inc.status !== "open") throw new Error("这份报告已经处理过了");
    const opt = inc.options[index];
    if (!opt) throw new Error("没有这个方案");
    const { db, runs } = this.#d;
    const resolve = (resolution: string) => {
      db.prepare("UPDATE incidents SET status = 'adopted', resolution = ?, resolved_at = ? WHERE id = ?").run(resolution, nowIso(), id);
      audit(db, actor, "incident.adopt", { id, option: opt.title, action: opt.action });
      if (inc.run_id) runs.notice(inc.run_id, "incident", `已采用方案「${opt.title}」`, id);
      this.#publish(id);
      return this.get(id)!;
    };
    const run = inc.run_id ? runs.get(inc.run_id) : undefined;
    const live = run && !["done", "failed", "cancelled"].includes(run.status);
    switch (opt.action) {
      case "wait":
        if (live) db.prepare("UPDATE runs SET check_after = ?, interventions = 0 WHERE id = ?").run(inMinutes(30), run.id);
        return resolve(live ? `${opt.title}：30 分钟后监督员再看` : `${opt.title}（任务已经结束）`);
      case "restart":
        if (live) await runs.restart(run.id, `主人选择：${opt.title}`, resumeText("主人要求重启"), actor);
        return resolve(live ? opt.title : `${opt.title}（任务已经结束）`);
      case "stop":
        if (live) await runs.interrupt(run.id, actor);
        return resolve(opt.title);
    }
    if (!inc.agent_id || !inc.conversation_id) throw new Error("报告没有关联的对话");
    if (opt.action === "switch_model") {
      if (!opt.model) throw new Error("方案缺少模型");
      runs.setConversationModel(inc.conversation_id, { model: opt.model });
    } else if (opt.action === "restart_agent") {
      // State lives in the volumes; the next start recreates the container.
      await this.#d.containers.remove(this.#d.containers.agentName(inc.agent_id));
    } else if (opt.action === "new_thread") {
      db.prepare("UPDATE conversations SET thread_id = NULL WHERE id = ?").run(inc.conversation_id);
    }
    const text = `${ADOPT_PREFIX}${opt.title}\n${opt.text || "按这个方案继续完成任务。"}`;
    await runs.send({ agentId: inc.agent_id, conversationId: inc.conversation_id, text, source: "incident" });
    return resolve(opt.title);
  }

  dismiss(id: string, actor: string): Incident {
    const inc = this.get(id);
    if (!inc) throw new Error("报告不存在");
    if (inc.status !== "open" && inc.status !== "analyzing") throw new Error("这份报告已经处理过了");
    this.#d.db.prepare("UPDATE incidents SET status = 'dismissed', resolution = '已忽略', resolved_at = ? WHERE id = ?").run(nowIso(), id);
    audit(this.#d.db, actor, "incident.dismiss", { id });
    this.#publish(id);
    return this.get(id)!;
  }

  /** Close open incidents that later work made moot. */
  #settle(run: RunRow): void {
    const { db } = this.#d;
    const now = nowIso();
    const stuck = db
      .prepare("UPDATE incidents SET status = 'auto', resolution = '任务已经结束', resolved_at = ? WHERE run_id = ? AND kind = 'stuck' AND status = 'open'")
      .run(now, run.id);
    const done =
      run.status === "done"
        ? db
            .prepare(
              "UPDATE incidents SET status = 'auto', resolution = '后续任务已完成', resolved_at = ? WHERE conversation_id = ? AND status = 'open' AND kind != 'stuck' AND created_at < ?",
            )
            .run(now, run.conversation_id, run.created_at)
        : { changes: 0 };
    if (Number(stuck.changes) + Number(done.changes) > 0) this.#d.events.publish("incident", { conversationId: run.conversation_id });
  }

  // ── runner repair ────────────────────────────────────────

  /** Whether a repair of this agent's container is under way. */
  repairing(agentId: string): boolean {
    return this.#repairs.has(agentId);
  }

  /** Recreate an agent's container (state lives in its volumes) and wait for the runner; one repair per agent at a time. */
  repairRunner(agentId: string, error: string): Promise<string[]> {
    const running = this.#repairs.get(agentId);
    if (running) return running;
    const job = (async () => {
      const { containers } = this.#d;
      const name = containers.agentName(agentId);
      const state = await containers.state(name).catch(() => "error" as const);
      const logs = await containers.logs(name, 30).catch(() => "");
      audit(this.#d.db, "system", "runner.repair", { agentId, error: error.slice(0, 300), state, logs: this.#redact(logs).slice(-2000) });
      const steps = [`容器状态：${STATE_TEXT[state] ?? state}`];
      if (state !== "missing") {
        await containers.remove(name);
        steps.push("删除了旧容器（文件和记忆保留）");
      }
      await this.#d.ensureRunner(agentId);
      steps.push("重新创建了容器，runner 已连上");
      return steps;
    })();
    this.#repairs.set(agentId, job);
    return job.finally(() => this.#repairs.delete(agentId));
  }

  // ── supervisor ───────────────────────────────────────────

  start(): void {
    this.#startedAt = Date.now();
    this.#timer = setInterval(() => void this.checkStuck(), 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Look at every running run that has shown no sign of life for a while. */
  async checkStuck(now = Date.now()): Promise<void> {
    const { db } = this.#d;
    // A question about a run that came back to life is moot.
    const reopened = db
      .prepare(
        `UPDATE incidents SET status = 'auto', resolution = '任务自己恢复了', resolved_at = ?
         WHERE kind = 'stuck' AND status = 'open' AND run_id IN (SELECT id FROM runs WHERE last_event_at > incidents.created_at)`,
      )
      .run(nowIso());
    if (Number(reopened.changes)) this.#d.events.publish("incident", {});
    const minutes = this.#d.limits?.().runWatchdogMinutes ?? config.runWatchdogMinutes;
    if (minutes <= 0) return;
    const rows = db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as unknown as RunRow[];
    const jobs: Promise<void>[] = [];
    for (const run of rows) {
      if (now - Math.max(Date.parse(run.last_event_at ?? run.created_at), this.#startedAt) < minutes * 60_000) continue;
      if (run.check_after && now < Date.parse(run.check_after)) continue;
      if (this.#supervising.has(run.id)) continue;
      this.#supervising.add(run.id);
      jobs.push(
        this.#supervise(run)
          .catch((err) => console.error("supervise failed", run.id, err))
          .finally(() => this.#supervising.delete(run.id)),
      );
    }
    await Promise.all(jobs);
  }

  async #supervise(run: RunRow): Promise<void> {
    const { containers } = this.#d;
    const events = this.#d.events.forRun(run.id);
    const pending = pendingTools(events);
    // Waiting on the owner (desktop hand-over, a question) isn't being stuck.
    if (pending.some((p) => WAITING_ON_OWNER.has(p.name))) {
      this.#d.db.prepare("UPDATE runs SET check_after = ? WHERE id = ?").run(inMinutes(15), run.id);
      return;
    }
    const idleMin = Math.round((Date.now() - Date.parse(run.last_event_at ?? run.created_at)) / 60_000);
    if (run.interventions >= MAX_INTERVENTIONS) {
      return this.#escalate(run, `已经 ${idleMin} 分钟没有进展，监督员介入 ${run.interventions} 次后仍没有恢复。`, []);
    }
    // The ladder: restarting the turn didn't help → rebuild the container; rebuilding didn't help either → the owner decides.
    if (run.progress === 0 && run.prompt === AFTER_REBUILD) {
      return this.#escalate(run, `重建 agent 容器后任务仍然卡住（已经 ${idleMin} 分钟没有进展）。`, []);
    }
    if (run.progress === 0 && run.prompt === AFTER_RESTART) {
      return this.#apply(run, { assessment: `重启这一轮之后仍然卡住（已经 ${idleMin} 分钟没有进展），引擎本身可能卡死了。`, action: "rebuild" }, []);
    }
    const name = containers.agentName(run.agent_id);
    const state = await containers.state(name).catch(() => "error" as const);
    // Rules first: a container that isn't running, or a runner that isn't there, needs no model to tell what to do.
    if (state !== "running") return this.#apply(run, { assessment: `agent 容器${STATE_TEXT[state] ?? state}，runner 不在线。`, action: "restart" }, []);
    if (!this.#d.connected(run.agent_id)) return this.#apply(run, { assessment: "agent 容器在运行，但 runner 没有连上 hub。", action: "restart" }, []);
    const ps = await containers.exec(name, ["ps", "-eo", "pid,ppid,etimes,stat,pcpu,args", "--sort=start_time"], { user: "agent" }).catch(() => null);
    const procs = ps ? parsePs(ps.output) : [];
    let verdict: Verdict;
    try {
      verdict = parseVerdict(await this.#d.llm.chatJson(this.#d.model(), SUPERVISE_SYSTEM, this.#stuckContext(run, events, pending, procs, idleMin))) ?? {
        assessment: "监督模型的回答格式不对。",
        action: run.interventions ? "escalate" : "restart",
      };
    } catch (err) {
      // Without a judgement, follow the rule: restart once, then ask the owner.
      verdict = { assessment: `监督模型暂时不可用（${errMessage(err).slice(0, 80)}）。`, action: run.interventions ? "escalate" : "restart" };
    }
    await this.#apply(run, verdict, procs);
  }

  async #apply(run: RunRow, v: Verdict, procs: Proc[]): Promise<void> {
    const { db, runs, containers } = this.#d;
    let did = "";
    let checkAfter: string | null = null;
    let action = v.action;
    if (action === "kill") {
      const pids = killable(procs, v.pids ?? []);
      if (pids.length) {
        const name = containers.agentName(run.agent_id);
        await containers.exec(name, ["kill", "-TERM", ...pids.map(String)], { user: "agent" }).catch(() => null);
        setTimeout(() => void containers.exec(name, ["kill", "-KILL", ...pids.map(String)], { user: "agent" }).catch(() => null), 5_000).unref();
        if (v.text) runs.hint(run.id, `［监督员］${v.text}`);
        did = `结束了卡住的进程（${pids.map((p) => `${p} ${procs.find((x) => x.pid === p)?.args.slice(0, 60) ?? ""}`.trim()).join("；")}）`;
        checkAfter = inMinutes(5);
      } else action = "restart"; // nothing it may stop: fall back to restarting the turn
    }
    if (action === "hint") {
      if (v.text && runs.hint(run.id, `［监督员提示］${v.text}`)) {
        did = `提醒 agent：${v.text}`;
        checkAfter = inMinutes(5);
      } else action = "restart";
    }
    if (action === "wait") {
      const m = Math.min(60, Math.max(5, Math.round(v.minutes ?? 15)));
      did = `判断任务仍在正常进行，${m} 分钟后再看`;
      checkAfter = inMinutes(m);
    }
    if (action === "escalate") return this.#escalate(run, v.assessment, v.options ?? []);
    if (action === "restart") {
      did = "停止了这一轮，稍后在原对话里自动接着做";
      checkAfter = inMinutes(2); // the stop lands within seconds; don't judge the same run again meanwhile
      await runs.restart(run.id, `监督员：${v.assessment}`, AFTER_RESTART, "supervisor");
    }
    if (action === "rebuild") {
      did = "重建了 agent 容器（文件和记忆保留），稍后在原对话里自动接着做";
      checkAfter = inMinutes(3);
      await runs.restart(run.id, `监督员：${v.assessment}`, AFTER_REBUILD, "supervisor");
      await this.repairRunner(run.agent_id, `监督员：${v.assessment}`).catch((err) => {
        did = `重建 agent 容器失败：${errMessage(err).slice(0, 120)}`;
      });
    }
    db.prepare("UPDATE runs SET interventions = interventions + 1, check_after = ? WHERE id = ?").run(checkAfter, run.id);
    audit(db, "supervisor", `supervisor.${action}`, { runId: run.id, assessment: v.assessment, did });
    runs.notice(run.id, "supervisor", `监督员介入：${v.assessment} → ${did}`);
    this.file({
      kind: "stuck",
      agentId: run.agent_id,
      conversationId: run.conversation_id,
      runId: run.id,
      title: "任务卡住，监督员已处理",
      summary: v.assessment,
      actions: [did],
      resolved: true,
    });
  }

  /** The owner decides: one open question per run, with options that are always safe to offer. */
  #escalate(run: RunRow, assessment: string, raw: unknown[]): void {
    const { db } = this.#d;
    db.prepare("UPDATE runs SET interventions = interventions + 1, check_after = ? WHERE id = ?").run(inMinutes(60), run.id);
    if (db.prepare("SELECT 1 FROM incidents WHERE run_id = ? AND kind = 'stuck' AND status = 'open'").get(run.id)) return;
    const given = cleanOptions(raw, STUCK_ACTIONS, [], "");
    const options: IncidentOption[] = given.length
      ? given
      : [
          { title: "重启这一轮", detail: "停止这一轮，然后在原对话里自动接着做", action: "restart", text: "" },
          { title: "继续等待", detail: "可能只是比较慢；30 分钟后监督员再看", action: "wait", text: "" },
          { title: "停止任务", detail: "结束这个任务，之后可以手动继续", action: "stop", text: "" },
        ];
    audit(db, "supervisor", "supervisor.escalate", { runId: run.id, assessment });
    this.file({
      kind: "stuck",
      agentId: run.agent_id,
      conversationId: run.conversation_id,
      runId: run.id,
      title: "任务卡住了，需要你决定",
      summary: assessment,
      options,
      recommended: 0,
    });
  }

  #stuckContext(run: RunRow, events: AgentEvent[], pending: PendingTool[], procs: Proc[], idleMin: number): string {
    const ageMin = Math.round((Date.now() - Date.parse(run.created_at)) / 60_000);
    const now = Date.now();
    const text = [
      `## 任务\n${run.prompt.slice(0, 1500)}`,
      `## 状态\n已经 ${idleMin} 分钟没有任何进展。这一轮已运行 ${ageMin} 分钟，监督员此前介入 ${run.interventions} 次。`,
      pending.length
        ? `## 正在执行、还没返回的工具调用\n${pending
            .map((p) => `- ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 600)}（已 ${Math.round((now - Date.parse(p.ts)) / 60_000)} 分钟）\n  输出尾部：\n${p.output.slice(-1500) || "（没有输出）"}`)
            .join("\n")}`
        : "## 正在执行的工具调用\n（无：没有在等任何工具返回）",
      `## 最近的步骤\n${transcriptFor(run, events).slice(-4000)}`,
      `## agent 容器里的进程（pid ppid 已运行秒数 状态 CPU% 命令）\n${procs.length ? procs.map((p) => `${p.pid} ${p.ppid} ${p.seconds} ${p.stat} ${p.cpu} ${p.args.slice(0, 200)}`).join("\n") : "（读取失败）"}`,
    ].join("\n\n");
    return this.#redact(text);
  }

  // ── helpers ──────────────────────────────────────────────

  async #materials(inc: Incident, models: string[], currentModel: string): Promise<string> {
    const { db, runs, containers, events } = this.#d;
    const agent = inc.agent_id ? this.#agent(inc.agent_id) : undefined;
    const run = inc.run_id ? runs.get(inc.run_id) : undefined;
    const recent = inc.conversation_id
      ? (db.prepare("SELECT prompt, status, error, progress FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 6").all(inc.conversation_id) as {
          prompt: string;
          status: string;
          error: string | null;
          progress: number;
        }[])
      : [];
    const name = agent ? containers.agentName(agent.id) : "";
    const state = name ? await containers.state(name).catch(() => "error") : "unknown";
    const logs = name ? await containers.logs(name, 60).catch(() => "") : "";
    const asked = this.#ownerRequests(inc.conversation_id);
    const text = [
      `## 出错的任务\nagent：${agent?.name ?? "?"}（当前模型 ${currentModel || "?"}）\n类型：${DEFAULT_TITLE[inc.kind]}\n错误：${inc.error ?? "（无）"}`,
      asked.length ? `## 主人的请求（按时间先后，最后一条是当前在做的）\n${asked.map((p) => `- ${p.slice(0, 1500)}`).join("\n")}` : "",
      inc.actions.length ? `## 系统已经做过的处理\n${inc.actions.map((a) => `- ${a}`).join("\n")}` : "",
      recent.length
        ? `## 这个对话最近几轮（新的在前）\n${recent.map((r) => `- [${r.status}，${r.progress} 个工具调用成功] ${r.prompt.replace(/\s+/g, " ").slice(0, 100)}${r.error ? ` → ${r.error.slice(0, 200)}` : ""}`).join("\n")}`
        : "",
      run ? `## 出错这一轮的记录\n${transcriptFor(run, events.forRun(run.id)).slice(-6000)}` : "",
      `## agent 容器\n状态：${state}\n最近日志：\n${logs.slice(-3000) || "（无）"}`,
      `## 可用模型\n${models.slice(0, 40).join("、") || "（未知）"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return this.#redact(text);
  }

  /** Options that always make sense when the diagnosis model can't be asked. */
  #fallback(inc: Incident, models: string[], currentModel: string, why: string) {
    const options: IncidentOption[] = [
      { title: "再试一次", detail: "在原对话里让 agent 从中断处继续，同一做法再失败就换一种", action: "continue", text: "上次任务出错中断了（错误见上文）。请先弄清原因，再从中断的地方继续完成；如果同样的做法再次失败，换一种做法。" },
    ];
    const other = models.find((m) => m !== currentModel);
    if (other) options.push({ title: `换成 ${other.slice(0, 20)}`, detail: "这个对话改用另一个模型后继续", action: "switch_model", model: other, text: "换了模型。请从中断的地方继续完成上次的任务。" });
    options.push({ title: "重建容器后继续", detail: "agent 的运行环境可能坏了；重建容器，文件和记忆都保留", action: "restart_agent", text: "运行环境已经重建。请从中断的地方继续完成上次的任务。" });
    options.push({ title: "清空上下文重来", detail: "对话上下文可能过长或损坏；清空后带着任务重新开始", action: "new_thread", text: `之前的会话上下文已清空。请重新完成这个任务：${this.#firstRequest(inc.conversation_id).slice(0, 1500)}` });
    return { title: DEFAULT_TITLE[inc.kind], summary: `${why}。错误信息：${(inc.error ?? "未知").slice(0, 300)}`, options, recommended: 0 };
  }

  #firstRequest(conversationId: string | null): string {
    const asked = this.#ownerRequests(conversationId);
    return asked.at(-1) ?? "";
  }

  /** What the owner asked in this conversation: the first request and the latest few (not the hub's own prompts). */
  #ownerRequests(conversationId: string | null): string[] {
    if (!conversationId) return [];
    const rows = this.#d.db.prepare("SELECT prompt FROM runs WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as { prompt: string }[];
    const own = rows.map((r) => r.prompt).filter((p) => !p.startsWith("［自动继续］") && !p.startsWith("［采用方案］"));
    return own.length > 4 ? [own[0]!, ...own.slice(-3)] : own;
  }

  #agent(id: string) {
    try {
      return this.#d.agents.get(id);
    } catch {
      return undefined;
    }
  }

  #notifyOpen(inc: Incident): void {
    const agent = inc.agent_id ? this.#agent(inc.agent_id) : undefined;
    this.#d.notify(
      `${agent?.name ?? "agent"}：${inc.title}`,
      `${inc.summary.slice(0, 100)}（${inc.options.length} 个方案可选）`,
      inc.conversation_id ? `/c/${inc.conversation_id}` : "/audit",
      inc.kind === "stuck" ? "stuck" : "failed",
    );
  }

  #publish(id: string): void {
    const row = this.#d.db.prepare("SELECT conversation_id FROM incidents WHERE id = ?").get(id) as { conversation_id: string | null } | undefined;
    this.#d.events.publish("incident", { id, conversationId: row?.conversation_id ?? null });
  }

  #redact(text: string): string {
    return redact(text, this.#d.secretValues());
  }
}

interface PendingTool {
  name: string;
  input: unknown;
  ts: string;
  output: string;
}

/** Tool calls that started and haven't returned, with the tail of their output. */
function pendingTools(events: AgentEvent[]): PendingTool[] {
  const open = new Map<string, PendingTool>();
  for (const ev of events) {
    if (ev.type === "tool.started") open.set(ev.callId, { name: ev.name, input: ev.input, ts: ev.ts, output: "" });
    else if (ev.type === "tool.output") {
      const t = open.get(ev.callId);
      if (t) t.output = (t.output + ev.chunk).slice(-4000);
    } else if (ev.type === "tool.completed") open.delete(ev.callId);
  }
  return [...open.values()];
}

const STATE_TEXT: Record<string, string> = { running: "运行中", stopped: "已停止", missing: "不存在", starting: "启动中", error: "异常" };

function toIncident(row: Record<string, any>): Incident {
  return { ...row, actions: JSON.parse(row.actions || "[]"), options: JSON.parse(row.options || "[]") } as Incident;
}

function inMinutes(m: number): string {
  return new Date(Date.now() + m * 60_000).toISOString();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
