import type { AgentEvent } from "@constella/protocol";
import { z } from "zod";
import type { Agents } from "./agents.ts";
import { config, newId, nowIso } from "./config.ts";
import type { Containers } from "./containers.ts";
import { audit, type Db } from "./db.ts";
import type { DesktopRow, Desktops, InstanceHealth, RepairResult } from "./desktops.ts";
import type { EventStore } from "./events.ts";
import type { HostCapabilities } from "./hostcaps.ts";
import { transcriptFor } from "./learning.ts";
import type { ModelRegistry } from "./models.ts";
import { ADOPT_PREFIX, RESUME_PREFIX, SUPERVISOR_PREFIX, resumeText, type NotifyKind, type RunLimits, type RunManager, type RunRow } from "./runs.ts";
import { redact } from "./secrets.ts";

/**
 * Self-maintenance with rules. Everything the hub does on its own goes through here and is recorded:
 * - repairing an agent whose runner can't be reached (recreate its container);
 * - incidents: failures the hub can't fix itself get a model-written diagnosis with options the owner
 *   adopts in one click (each option is one of a fixed set of actions);
 * - the supervisor: a separate model that looks at runs which stopped making progress and picks one of a
 *   few bounded actions (wait, stop a stuck process, hint, restart the turn, ask the owner);
 * - instances: a patrol repairs instances that broke (crash loops, a control service that stopped answering);
 * - the helper (维修员): agents stuck on something they can't see or fix call get_help; it looks at their
 *   instances' containers and logs, repairs what is broken and tells them what to do next;
 * - ending review: a turn may only end when the job is done. One that ended early is a "panic": recorded and
 *   pushed to the owner, the agent is pulled back, and the owner decides only after that didn't help.
 * Every one of these leaves a report: handled ones for the record, the rest with options for the owner.
 */

/** `panic`: a turn ended before the job was done (the agent gave up, or stopped to wait for the owner). */
export type IncidentKind = "start_failure" | "engine_error" | "stalled" | "stuck" | "panic" | "instance" | "help";
export type IncidentStatus = "analyzing" | "open" | "auto" | "adopted" | "dismissed";

/** What an option does when adopted. Diagnoses offer the first four; stuck-run questions wait / restart / stop (and continue); broken instances the last three. */
const ACTIONS = ["continue", "switch_model", "restart_agent", "new_thread", "wait", "restart", "stop", "repair_instance", "reset_instance", "stop_instance"] as const;
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
  agentId: string | null;
  /** The instance it is about, if any. */
  desktopId?: string | null;
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
  desktop_id: string | null;
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
  panic: "Panic：任务没做完，需要你决定",
  instance: "实例出了故障",
  help: "agent 求助",
};

/** Supervisor: after this many interventions on one run the owner decides. */
export const MAX_INTERVENTIONS = 3;
/** Prompts of the continuations after the supervisor restarted a turn / rebuilt the container (how the ladder knows where it is). */
const AFTER_RESTART = resumeText("卡住（监督员重启了这一轮）");
const AFTER_REBUILD = resumeText("卡住（监督员重建了 agent 容器）");
/** Ending review: after this many pull-backs in a row that still ended unfinished, the owner decides. */
export const MAX_PULLBACKS = 2;
/** get_help calls per turn; past this the agent should change course or ask the owner. */
export const MAX_HELP_CALLS = 3;
/** A failed automatic instance repair isn't tried again by the patrol for this long. */
const REPAIR_BACKOFF_MS = 60 * 60_000;
/** Checks in a row an instance has to look broken before the patrol repairs it (a crash loop needs just one). */
const BROKEN_CHECKS = 3;
/** Tools that legitimately wait on the owner; a run inside one isn't stuck. */
const WAITING_ON_OWNER = new Set(["constella.desktop_request_help", "constella.ask_user", "constella.credentials_fill"]);

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

const ENDING_SYSTEM = `你是 Constella 平台的"监督员"。规矩是：agent 只有在主人要的事情做完了才能结束一轮。一个 agent 刚结束了一轮，请判断它是不是真的做完了。只输出一个 JSON 对象：
{"verdict":"completed|needs_owner|gave_up","assessment":"一两句话：结论和依据","text":"不是 completed 时，直接对 agent 说的指示"}
- completed：主人要的结果已经做到并交付了（东西装好了、文件发了、问题答了、改动生效了）；或者剩下的部分客观上不可能做到（目标不存在、网站已下线），并且说清楚了。只是"做了一部分""给了建议""说明了原因"不算。
- needs_owner：停下来是为了等主人本人做某一步（验证码、扫码、付款）或者等主人拍板（会花钱、会丢数据、目标不明确的取舍）。这也不该结束这一轮：应该用 desktop_request_help 请主人接管实例、用 ask_user 请主人选，在这一轮里等，等的时候先做不依赖主人的部分。
- 缺少登录用的用户名、密码或验证码，用 credentials_fill 向密码库取或请主人在聊天里输入后，主人仍然没有提供：这是在等主人，不算 gave_up，按 completed 处理。
- gave_up：没做完就停了，而挡住它的是 agent 或平台自己能处理的事：工具报错或超时、实例没响应、网络或下载失败、页面变了、一种做法行不通、"建议稍后重试"、问主人"要不要继续"、把自己能做的步骤推给主人等。
text：指出它停在哪里、接下来具体怎么做（重试、instance_restart 修实例、get_help 找平台维修员、instance_create / instance_use 换实例、换工具、换做法；要主人的步骤用 desktop_request_help / ask_user 在这一轮里等），要求它把任务做完再结束。用中文。
主人只是聊天或提问、回答已经给了，就是 completed。`;

const HELP_SYSTEM = `你是 Constella 平台的"维修员"。一个 agent 干活时遇到了自己解决不了的问题，向你求助。你能看到它看不到的东西：它的实例（浏览器 / Linux 桌面 / 安卓）的容器状态、重启次数和日志，它自己容器里的进程，这台服务器能新建哪些实例。坏掉的实例系统已经按规则修过了，结果在材料里。
判断问题出在哪里，告诉 agent 具体的下一步。只输出一个 JSON 对象：
{"diagnosis":"一两句话：问题是什么、证据是什么","advice":"直接对 agent 说的下一步","kill":[],"needsOwner":false}
- advice：先说现在的状况（例如实例已经修好可以继续，或者还没恢复），再给做法。原路走不通时给替代路线：换一台实例（instance_use 已有的或 instance_create 新建）、换工具（例如安卓上 android_apps 直接安装 APK 网址，或先在自己的容器里下载再安装）、换做法、分步重试。不要建议放弃或"稍后再试"。
- kill：agent 容器里卡死、需要结束的进程号（只能填进程列表里由 agent 的命令产生的进程），没有就是空数组。
- needsOwner：只有接下来必须主人本人做（登录、验证码、付款）或者需要主人拍板（会丢数据、会花钱）时才填 true，并在 advice 里说明让 agent 用 ask_user 或 desktop_request_help 问什么。
- 会丢数据的操作（清空实例、删除文件等）不要让 agent 自己做，交给主人决定。`;

/**
 * Words a reply uses when the job isn't done, or when it stops to hand something back ("要不要继续？"). Turns that
 * used tools are always reviewed; a plain chat reply only when it says one of these.
 */
const UNFINISHED =
  /没(能|有)?(装|做|完成|成功|办成|弄好|搞定|跑通|找到|下载|打开)|未(能|完成|成功)|无法|失败|做不了|办不到|放弃|暂时|稍后|再试|重试|卡在|卡住|超时|没办法|不可用|没有?响应|无响应|出错|报错|中断|要不要|是否(继续|需要)|要我(继续|再)|需要你|等你|请你|你来|确认后|下次|之后再|回头再/;

/** Whether a final reply sounds like the job isn't done (cheap filter before asking the model). */
export function soundsUnfinished(text: string): boolean {
  return UNFINISHED.test(text);
}

const Ending = z.object({
  verdict: z.enum(["completed", "needs_owner", "gave_up"]),
  assessment: z.string().trim().min(1).max(600),
  text: z.string().trim().max(1500).default(""),
});
export type Ending = z.infer<typeof Ending>;

export function parseEnding(raw: unknown): Ending | null {
  const p = Ending.safeParse(raw);
  return p.success ? p.data : null;
}

const HelpVerdict = z.object({
  diagnosis: z.string().trim().min(1).max(800),
  advice: z.string().trim().min(1).max(2000),
  kill: z.array(z.number().int()).max(20).default([]),
  needsOwner: z.boolean().default(false),
});
export type HelpVerdict = z.infer<typeof HelpVerdict>;

export function parseHelp(raw: unknown): HelpVerdict | null {
  const p = HelpVerdict.safeParse(raw);
  return p.success ? p.data : null;
}

/** What the owner can do about an instance the hub couldn't repair. */
export function instanceOptions(row: Pick<DesktopRow, "kind" | "name">, conversationId: string | null): IncidentOption[] {
  const options: IncidentOption[] = [{ title: "再修一次", detail: "再停止并重启一次，不行就重建容器（数据保留）", action: "repair_instance", text: "" }];
  if (conversationId) {
    options.push({
      title: "让 agent 换一台继续",
      detail: "agent 新建或换用另一台实例，接着完成任务",
      action: "continue",
      text: `你在用的实例「${row.name}」坏了，系统修复没有成功。用 instance_use 换一台已有的实例，或用 instance_create 新建一台，接着完成任务。`,
    });
  }
  if (row.kind === "android") options.push({ title: "清空重建", detail: "删掉安卓数据，从全新的系统启动；装过的 App 和登录状态会丢", action: "reset_instance", text: "" });
  options.push({ title: "先停用这台", detail: "停止实例、释放内存；之后用到时会再启动", action: "stop_instance", text: "" });
  return options;
}

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
  /** Instances: diagnosing and repairing them (patrol, helper, owner options). */
  desktops?: Pick<Desktops, "rows" | "row" | "boundTo" | "describe" | "diagnose" | "repair" | "reset" | "stop" | "busy">;
  /** What kinds of instance this host can create (for the helper). */
  hostcaps?: Pick<HostCapabilities, "snapshot">;
  /** Whether turns that end unfinished get pulled back (on unless turned off). */
  endingReview?(): boolean;
}

export class Recovery {
  #d: RecoveryDeps;
  #repairs = new Map<string, Promise<string[]>>();
  #supervising = new Set<string>();
  /** Runs whose "done" is under review: their conversation's reports aren't settled yet. */
  #reviewing = new Set<string>();
  #helpCalls = new Map<string, number>();
  /** Instance patrol: checks in a row each instance looked broken, and when it may be repaired automatically again. */
  #broken = new Map<string, number>();
  #backoff = new Map<string, number>();
  #patrolling = false;
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
      `INSERT INTO incidents (id, kind, agent_id, conversation_id, run_id, desktop_id, title, summary, error, actions, options, recommended, status, resolution, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.agentId,
      input.conversationId,
      input.runId,
      input.desktopId ?? null,
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
    audit(db, "system", `incident.${input.kind}`, { id, runId: input.runId, desktopId: input.desktopId ?? undefined, status, title, error: input.error?.slice(0, 300) });
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
      case "repair_instance":
      case "reset_instance": {
        const desktops = this.#d.desktops;
        if (!desktops || !inc.desktop_id) throw new Error("报告没有关联的实例");
        const res = opt.action === "reset_instance" ? await desktops.reset(inc.desktop_id, actor) : await desktops.repair(inc.desktop_id);
        if (!res.ok) {
          // Still broken: the report stays open with what this attempt found, so another option can be picked.
          db.prepare("UPDATE incidents SET summary = ?, error = ?, actions = ? WHERE id = ?").run(
            `${opt.title}之后仍没有恢复：${res.after.problem ?? "原因不明"}`,
            this.#redact(res.after.detail).slice(0, 4000),
            JSON.stringify([...inc.actions, ...res.steps]),
            id,
          );
          audit(db, actor, "incident.adopt", { id, option: opt.title, action: opt.action, ok: false });
          this.#publish(id);
          throw new Error(`${opt.title}之后仍没有恢复，可以试试其他方案`);
        }
        if (live) runs.notice(run.id, "recovery", `${opt.title}：实例已经恢复（${res.steps.join("；")}）`, id);
        return resolve(`${opt.title}：已恢复`);
      }
      case "stop_instance":
        if (!this.#d.desktops || !inc.desktop_id) throw new Error("报告没有关联的实例");
        await this.#d.desktops.stop(inc.desktop_id, { keepFrame: false });
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

  /** Close open incidents that later work made moot. A "done" under review only counts once the review lets it stand. */
  #settle(run: RunRow): void {
    const { db } = this.#d;
    this.#helpCalls.delete(run.id);
    const stuck = db
      .prepare("UPDATE incidents SET status = 'auto', resolution = '任务已经结束', resolved_at = ? WHERE run_id = ? AND kind = 'stuck' AND status = 'open'")
      .run(nowIso(), run.id);
    if (Number(stuck.changes)) this.#d.events.publish("incident", { conversationId: run.conversation_id });
    if (run.status === "done" && !this.#reviewing.has(run.id)) this.#settleDone(run);
  }

  #settleDone(run: RunRow): void {
    const done = this.#d.db
      .prepare(
        "UPDATE incidents SET status = 'auto', resolution = '后续任务已完成', resolved_at = ? WHERE conversation_id = ? AND status = 'open' AND kind NOT IN ('stuck', 'instance') AND created_at < ?",
      )
      .run(nowIso(), run.conversation_id, run.created_at);
    if (Number(done.changes)) this.#d.events.publish("incident", { conversationId: run.conversation_id });
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
    this.#timer = setInterval(() => {
      void this.checkStuck();
      void this.checkInstances().catch((err) => console.error("instance patrol failed", err));
    }, 60_000);
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

  // ── instances ────────────────────────────────────────────

  /** An open report about this instance, if there is one (one at a time). */
  #openFor(desktopId: string): boolean {
    return !!this.#d.db.prepare("SELECT 1 FROM incidents WHERE desktop_id = ? AND status IN ('open','analyzing')").get(desktopId);
  }

  /**
   * Repair an instance and put it on the record: repaired → a report for the record (and a line in the run that
   * was using it); still broken → a report with options for the owner.
   */
  async repairInstance(
    desktopId: string,
    ctx: { by: "patrol" | "agent" | "helper"; agentId?: string | null; runId?: string | null; why?: string },
  ): Promise<RepairResult> {
    const desktops = this.#d.desktops;
    if (!desktops) throw new Error("没有实例管理");
    const row = desktops.row(desktopId);
    const run = ctx.runId ? this.#d.runs.get(ctx.runId) : undefined;
    const res = await desktops.repair(desktopId);
    const who = { patrol: "巡检发现", agent: "agent 发现", helper: "维修员发现" }[ctx.by];
    const symptom = ctx.why ?? res.before.problem ?? "没有响应";
    const base = { kind: "instance" as const, desktopId, agentId: ctx.agentId ?? null, conversationId: run?.conversation_id ?? null, runId: run?.id ?? null };
    if (res.ok) {
      const inc = this.file({
        ...base,
        title: `${row.name}出了故障，已经修好`,
        summary: `${who}：${symptom}`,
        error: res.before.detail,
        actions: res.steps,
        resolved: true,
      });
      if (run) this.#d.runs.notice(run.id, "recovery", `实例「${row.name}」${symptom}，已经修好：${res.steps.join("；")}`, inc.id);
    } else if (!this.#openFor(desktopId)) {
      this.file({
        ...base,
        title: `${row.name}坏了，需要你决定`,
        summary: `${who}：${symptom}。已经试过正常停止后重启、重建容器，仍没有恢复${res.after.problem ? `（现在：${res.after.problem}）` : ""}。`,
        error: res.after.detail,
        actions: res.steps,
        options: instanceOptions(row, base.conversationId),
        recommended: 0,
      });
    }
    return res;
  }

  /**
   * The instance patrol (every minute): an instance that keeps crashing, or hasn't answered for a few checks in
   * a row, is repaired without waiting for anyone to notice. Instances the owner is using are left alone.
   */
  async checkInstances(now = Date.now()): Promise<void> {
    const desktops = this.#d.desktops;
    if (!desktops || this.#patrolling) return;
    this.#patrolling = true;
    try {
      for (const row of desktops.rows()) {
        if (desktops.busy(row.id)) continue;
        const h: InstanceHealth | null = await desktops.diagnose(row.id).catch(() => null);
        if (!h || h.ok || h.state === "starting") {
          this.#broken.delete(row.id);
          continue;
        }
        const n = (this.#broken.get(row.id) ?? 0) + 1;
        this.#broken.set(row.id, n);
        if (!h.crashLoop && n < BROKEN_CHECKS) continue;
        if ((this.#backoff.get(row.id) ?? 0) > now || this.#openFor(row.id)) continue;
        const lease = JSON.parse(row.lease) as { holder: string; agentId?: string; runId?: string };
        if (lease.holder === "human") continue;
        this.#broken.delete(row.id);
        const res = await this.repairInstance(row.id, {
          by: "patrol",
          agentId: lease.holder === "agent" ? lease.agentId : null,
          runId: lease.holder === "agent" ? lease.runId : null,
          why: h.problem,
        });
        if (res.ok) this.#backoff.delete(row.id);
        else this.#backoff.set(row.id, now + REPAIR_BACKOFF_MS);
      }
    } finally {
      this.#patrolling = false;
    }
  }

  // ── helper (维修员) ───────────────────────────────────────

  /**
   * An agent asks for help (get_help), or the ending review wants a look before pulling it back. Broken instances
   * of the agent's are repaired by rule first; then a model looks at everything the agent can't see and says
   * what to do next. Returns the text for the agent.
   */
  async help(input: { agentId: string; runId: string | null; problem: string; by: "agent" | "review" }): Promise<{ text: string; diagnosis: string; did: string[]; incidentId?: string }> {
    const { db, runs, containers, desktops } = this.#d;
    const run = input.runId ? runs.get(input.runId) : undefined;
    if (input.by === "agent" && run) {
      const calls = (this.#helpCalls.get(run.id) ?? 0) + 1;
      this.#helpCalls.set(run.id, calls);
      if (calls > MAX_HELP_CALLS) {
        return {
          text: `这一轮已经求助 ${MAX_HELP_CALLS} 次了，维修员能做的都做了。换一条路线完成任务（换实例、换工具、换做法）；确实需要主人本人做或拍板时，用 ask_user。`,
          diagnosis: "求助次数已用完",
          did: [],
        };
      }
    }
    const did: string[] = [];
    const instances: string[] = [];
    for (const row of desktops?.boundTo(input.agentId) ?? []) {
      let h: InstanceHealth | null = await desktops!.diagnose(row.id).catch(() => null);
      const lease = JSON.parse(row.lease) as { holder: string; runId?: string };
      if (h && !h.ok && h.state !== "starting") {
        if (lease.holder === "human") did.push(`${desktops!.describe(row)}：${h.problem}；主人正在操作它，没有动`);
        else if (lease.holder === "agent" && lease.runId !== run?.id) did.push(`${desktops!.describe(row)}：${h.problem}；另一个任务在用它，没有动`);
        else {
          const res = await this.repairInstance(row.id, { by: "helper", agentId: input.agentId, runId: run?.id ?? null, why: h.problem });
          did.push(`${desktops!.describe(row)}：${h.problem} → ${res.ok ? "已经修好" : "修复后仍没有恢复"}（${res.steps.join("；")}）`);
          h = res.after;
        }
      }
      instances.push(`### ${desktops!.describe(row)}\n${h?.detail ?? "（读取失败）"}\n结论：${h ? (h.ok ? "正常" : h.problem) : "未知"}`);
    }
    const name = containers.agentName(input.agentId);
    const ps = await containers.exec(name, ["ps", "-eo", "pid,ppid,etimes,stat,pcpu,args", "--sort=start_time"], { user: "agent" }).catch(() => null);
    const procs = ps ? parsePs(ps.output) : [];
    const caps = this.#d.hostcaps?.snapshot();
    const creatable = caps ? Object.entries(caps.kinds).map(([k, v]) => `${k}：${v.ok ? "可以" : `不能（${v.reason ?? ""}）`}`).join("；") : "未知";
    const materials = this.#redact(
      [
        `## agent 的求助\n${input.problem.slice(0, 2000)}`,
        this.#ownerRequests(run?.conversation_id ?? null).length ? `## 主人的请求\n${this.#ownerRequests(run?.conversation_id ?? null).map((p) => `- ${p.slice(0, 800)}`).join("\n")}` : "",
        run ? `## 这一轮的记录\n${transcriptFor(run, this.#d.events.forRun(run.id)).slice(-5000)}` : "",
        `## 它的实例\n${instances.join("\n\n") || "（没有绑定实例）"}`,
        did.length ? `## 系统刚才已经做了\n${did.map((x) => `- ${x}`).join("\n")}` : "",
        `## 这台服务器能新建的实例\n${creatable}`,
        `## agent 容器里的进程（pid ppid 已运行秒数 状态 CPU% 命令）\n${procs.map((p) => `${p.pid} ${p.ppid} ${p.seconds} ${p.stat} ${p.cpu} ${p.args.slice(0, 160)}`).join("\n") || "（读取失败）"}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    let v: HelpVerdict;
    try {
      v = parseHelp(await this.#d.llm.chatJson(this.#d.model(), HELP_SYSTEM, materials)) ?? this.#helpFallback(did, "维修员的回答格式不对");
    } catch (err) {
      v = this.#helpFallback(did, `维修员模型暂时不可用（${errMessage(err).slice(0, 80)}）`);
    }
    const pids = killable(procs, v.kill);
    if (pids.length) {
      await containers.exec(name, ["kill", "-TERM", ...pids.map(String)], { user: "agent" }).catch(() => null);
      did.push(`结束了卡住的进程（${pids.map((p) => `${p} ${procs.find((x) => x.pid === p)?.args.slice(0, 60) ?? ""}`.trim()).join("；")}）`);
    }
    const text = [`维修员诊断：${v.diagnosis}`, did.length ? `已经做了：\n${did.map((x) => `- ${x}`).join("\n")}` : "", `下一步：${v.advice}`].filter(Boolean).join("\n");
    audit(db, "helper", "helper.call", { agentId: input.agentId, runId: run?.id, by: input.by, problem: input.problem.slice(0, 300), diagnosis: v.diagnosis, did });
    if (input.by === "review") return { text, diagnosis: v.diagnosis, did };
    const inc = this.file({
      kind: "help",
      agentId: input.agentId,
      conversationId: run?.conversation_id ?? null,
      runId: run?.id ?? null,
      title: `求助：${input.problem.replace(/\s+/g, " ").slice(0, 40)}`,
      summary: v.diagnosis,
      error: input.problem,
      actions: [...did, `给 agent 的建议：${v.advice}`],
      resolved: true,
    });
    if (run) runs.notice(run.id, "supervisor", `维修员：${v.diagnosis}${did.length ? `（${did.join("；")}）` : ""}`, inc.id);
    return { text, diagnosis: v.diagnosis, did, incidentId: inc.id };
  }

  #helpFallback(did: string[], why: string): HelpVerdict {
    return {
      diagnosis: did.length ? `${why}；已经按规则处理了坏掉的实例。` : `${why}。`,
      advice: did.some((x) => x.includes("已经修好"))
        ? "实例已经修好，从中断的地方继续。同样的操作再出错就换一种做法。"
        : "换一条路线继续：换一台实例（instance_use 已有的，或 instance_create 新建）、换工具或换做法；确实需要主人本人做或拍板时用 ask_user。不要结束任务。",
      kill: [],
      needsOwner: false,
    };
  }

  // ── ending review ────────────────────────────────────────

  /**
   * A turn ended "done", and the rule is that a turn only ends when the job is done. Every turn that did work
   * (and any reply that sounds unfinished) gets a model's judgement: done, stopped to wait for the owner, or gave
   * up. Not done → the helper looks first (for give-ups), then the agent is pulled back with a "［监督员］"
   * message; after MAX_PULLBACKS of those in a row the owner gets a report with options.
   * Null when there is nothing to review (the ending stands right away).
   */
  reviewDone(run: RunRow): Promise<boolean> | null {
    if (this.#d.endingReview && !this.#d.endingReview()) return null;
    // It asked the owner and stopped instead of waiting: a panic, but not one to pull back (the answer, when it
    // comes, reaches it as a new message and the task goes on from there).
    if (this.#d.db.prepare("SELECT 1 FROM approvals WHERE run_id = ? AND kind = 'decision' AND status = 'pending'").get(run.id)) {
      this.#panic(run, { title: "Panic：问了你问题，没等回答就停下了", summary: "你回答后它会接着做。", actions: [] });
      return Promise.resolve(false);
    }
    // It needed a login and the owner didn't supply one (declined, or didn't come in time): that is waiting on
    // the owner, not giving up. No panic and no pull-back; asking again is the owner's "continue".
    const lastSecret = this.#d.db.prepare("SELECT status FROM approvals WHERE run_id = ? AND kind = 'secret' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(run.id) as
      | { status: string }
      | undefined;
    if (lastSecret && (lastSecret.status === "expired" || lastSecret.status === "denied")) {
      this.#d.runs.notice(run.id, "supervisor", "监督员：这一轮在等你提供登录信息（用户名、密码或验证码），没有就停下来是对的，不算 panic。让它继续时会再次请你输入。");
      return Promise.resolve(false);
    }
    const events = this.#d.events.forRun(run.id);
    const last = events
      .filter((e): e is Extract<AgentEvent, { type: "message.completed" }> => e.type === "message.completed")
      .map((e) => e.text)
      .filter((t) => !t.startsWith("［追加指示］"))
      .at(-1);
    if (!last || (run.tool_calls === 0 && !soundsUnfinished(last))) return null;
    this.#reviewing.add(run.id);
    return this.#reviewEnding(run, events, last)
      .catch((err) => {
        console.error("ending review failed", run.id, err);
        return this.#stands(run);
      })
      .finally(() => this.#reviewing.delete(run.id));
  }

  #stands(run: RunRow): boolean {
    this.#settleDone(run);
    return true;
  }

  async #reviewEnding(run: RunRow, events: AgentEvent[], last: string): Promise<boolean> {
    const { db, runs } = this.#d;
    const asked = this.#ownerRequests(run.conversation_id);
    const materials = this.#redact(
      [
        asked.length ? `## 主人的请求（最后一条是当前在做的）\n${asked.map((p) => `- ${p.slice(0, 1500)}`).join("\n")}` : `## 这一轮收到的消息\n${run.prompt.slice(0, 1500)}`,
        `## agent 最后的回复\n${last.slice(0, 3000)}`,
        `## 这一轮的记录\n${transcriptFor(run, events).slice(-6000)}`,
      ].join("\n\n"),
    );
    let v: Ending | null = null;
    try {
      v = parseEnding(await this.#d.llm.chatJson(this.#d.model(), ENDING_SYSTEM, materials));
    } catch {}
    // Without a judgement, the words decide: a reply that sounds unfinished is treated as one.
    v ??= soundsUnfinished(last)
      ? { verdict: "gave_up", assessment: "最后的回复像是没做完（复核模型暂时没给出判断）", text: "" }
      : { verdict: "completed", assessment: "复核模型暂时没给出判断", text: "" };
    audit(db, "supervisor", "run.ending_review", { runId: run.id, verdict: v.verdict, assessment: v.assessment });
    if (v.verdict === "completed") return this.#stands(run);
    // The owner stepped in meanwhile: on the record, but the conversation is theirs now.
    const latest = db.prepare("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(run.conversation_id) as { id: string } | undefined;
    if (latest?.id !== run.id || runs.activeRun(run.conversation_id)) {
      this.#panic(run, { title: "Panic：任务没做完就停下了", summary: `${v.assessment}（你已经接着发了消息，监督员没有再插手）`, error: last, actions: [], quiet: true });
      return false;
    }
    const rows = db.prepare("SELECT prompt FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20").all(run.conversation_id) as { prompt: string }[];
    let pulls = 0;
    while (pulls < rows.length && rows[pulls]!.prompt.startsWith(SUPERVISOR_PREFIX)) pulls++;
    if (pulls >= MAX_PULLBACKS) {
      this.file({
        kind: "panic",
        agentId: run.agent_id,
        conversationId: run.conversation_id,
        runId: run.id,
        error: last.slice(0, 2000),
        actions: [`监督员已经把它拉回 ${pulls} 次，它仍然没有完成：${v.assessment}`],
      });
      return false;
    }
    const waiting = v.verdict === "needs_owner";
    // Environment trouble gets the helper's look first; waiting on the owner doesn't need it.
    const help = waiting ? null : await this.help({ agentId: run.agent_id, runId: run.id, problem: v.assessment, by: "review" }).catch(() => null);
    const order =
      v.text ||
      (waiting
        ? "不要结束这一轮。需要主人本人做的步骤用 desktop_request_help 请主人接管实例，需要主人拍板的用 ask_user，在这一轮里等；等的同时先把不依赖主人的部分做完，主人回应后接着做完。"
        : "这不是需要主人处理的事。换一种做法继续，直到做完再结束；确实需要主人本人做或拍板时，用 desktop_request_help / ask_user 在这一轮里等。");
    await runs.send({
      agentId: run.agent_id,
      conversationId: run.conversation_id,
      text: `${SUPERVISOR_PREFIX}任务还没做完，你就结束了这一轮：${v.assessment}\n${help ? `${help.text}\n` : ""}${order}`,
      source: "supervisor",
    });
    const inc = this.#panic(run, {
      title: waiting ? "Panic：停下来等你，监督员让它在任务里等" : "Panic：没做完就想收工，监督员把它拉回来了",
      summary: v.assessment,
      error: last,
      actions: [...(help ? [`维修员：${help.diagnosis}`, ...help.did] : []), `让 agent 继续：${order}`],
      pushed: "监督员已让它接着做",
    });
    runs.notice(run.id, "supervisor", `监督员复核：${v.assessment} → 已经让 agent 接着做`, inc.id);
    return false;
  }

  /** A turn that stopped before the job was done: on the record (handled), and pushed to the owner unless `quiet`. */
  #panic(run: RunRow, p: { title: string; summary: string; error?: string; actions: string[]; pushed?: string; quiet?: boolean }): Incident {
    const inc = this.file({
      kind: "panic",
      agentId: run.agent_id,
      conversationId: run.conversation_id,
      runId: run.id,
      title: p.title,
      summary: p.summary,
      error: p.error?.slice(0, 2000) ?? null,
      actions: p.actions,
      resolved: true,
    });
    if (!p.quiet) {
      const agent = this.#agent(run.agent_id);
      this.#d.notify(`${agent?.name ?? "agent"} panic：任务没做完就停下了`, `${p.summary.slice(0, 100)}${p.pushed ? `（${p.pushed}）` : ""}`, `/c/${run.conversation_id}`, "panic");
    }
    return inc;
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
    const own = rows.map((r) => r.prompt).filter((p) => !p.startsWith(RESUME_PREFIX) && !p.startsWith(ADOPT_PREFIX) && !p.startsWith(SUPERVISOR_PREFIX));
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
      agent ? `${agent.name}：${inc.title}` : inc.title,
      `${inc.summary.slice(0, 100)}（${inc.options.length} 个方案可选）`,
      inc.conversation_id ? `/c/${inc.conversation_id}` : `/audit?id=${inc.id}`,
      inc.kind === "stuck" ? "stuck" : inc.kind === "panic" ? "panic" : "failed",
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
