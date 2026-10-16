import { Credentials } from "./credentials.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { IdleAction, INTELLIGENT_UI_LEVELS, RunnerToHubSchema, type HubToRunner, type IntelligentUiLevel, type RunnerEvent } from "@constella/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { Agents } from "./agents.ts";
import { Artifacts } from "./artifacts.ts";
import { Auth } from "./auth.ts";
import { EffortCatalog, EffortSchema, type Effort } from "./catalog.ts";
import { config, nowIso } from "./config.ts";
import { allowedOrigins } from "./origins.ts";
import { Containers } from "./containers.ts";
import { audit, kvGet, openDb, type Db } from "./db.ts";
import { Desktops } from "./desktops.ts";
import { EventStore } from "./events.ts";
import { HostCapabilities, type AndroidBackendSetting } from "./hostcaps.ts";
import { Knowledge } from "./knowledge.ts";
import { Learning } from "./learning.ts";
import { registerMcp } from "./mcp.ts";
import { ModelRegistry } from "./models.ts";
import { NewApi } from "./newapi.ts";
import { Notifier } from "./notify.ts";
import { registerRoutes } from "./routes.ts";
import { Recovery } from "./recovery.ts";
import { RunManager, type NotifyKind, type RunLimits } from "./runs.ts";
import { Scheduler } from "./scheduler.ts";
import { intelligentUiNote } from "./widgets.ts";
import { UiStreams } from "./streamui.ts";
import { Reflect } from "./reflect.ts";
import { PERMISSION_KINDS, SMART_KINDS, type ApprovalMode, type PermissionKind } from "./safety.ts";
import { OfficeService } from "./office.ts";
import { PerfMonitor } from "./perf.ts";
import { registerOfficeProxy } from "./office-proxy.ts";
import { SecretBox, SecretStore } from "./secrets.ts";

export interface Hub {
  app: FastifyInstance;
  db: Db;
  auth: Auth;
  credentials: Credentials;
  secrets: SecretStore;
  events: EventStore;
  /** Streaming UI blocks inside replies: the ops are read out of the reply as it is written. */
  ui: UiStreams;
  agents: Agents;
  runs: RunManager;
  /** Files and documents agents delivered, with their versions. */
  artifacts: Artifacts;
  recovery: Recovery;
  knowledge: Knowledge;
  learning: Learning;
  reflect: Reflect;
  desktops: Desktops;
  /** What this host can run (instance kinds, Android backends), probed with throwaway containers. */
  hostcaps: HostCapabilities;
  containers: Containers;
  /** Optional online Office editor (installed and managed from Settings). */
  office: OfficeService;
  /** Host and container performance samples (CPU, memory, network), a day of history in memory. */
  perf: PerfMonitor;
  scheduler: Scheduler;
  notifier: Notifier;
  newapi: NewApi;
  models: ModelRegistry;
  /** Reasoning levels each model supports, as reported by the agents' Codex. */
  catalog: EffortCatalog;
  runners: RunnerGateway;
  settings: Settings;
  backup(): Promise<string>;
  close(): Promise<void>;
  /** Restart the runner of an agent that still has unfinished runs (no-op when auto-resume is off). */
  reviveIfStranded(agentId: string, delayMs: number): void;
}

/** Live runner connections, one per agent container. */
export class RunnerGateway {
  #sockets = new Map<string, WebSocket>();
  #waiters = new Map<string, (() => void)[]>();
  /** Last activity either way (keeps an idle container from being stopped); pings don't count. */
  lastSeen = new Map<string, number>();
  /** Last time each runner said anything, pongs included: how a dead connection is told from a quiet one. */
  #heard = new Map<string, number>();
  #pinger: NodeJS.Timeout | null = null;

  connected(agentId: string): boolean {
    return this.#sockets.get(agentId)?.readyState === 1;
  }

  attach(agentId: string, ws: WebSocket): void {
    this.#sockets.get(agentId)?.close(4000, "replaced");
    this.#sockets.set(agentId, ws);
    this.lastSeen.set(agentId, Date.now());
    this.#heard.set(agentId, Date.now());
  }

  heard(agentId: string): void {
    this.#heard.set(agentId, Date.now());
  }

  /**
   * Ping every runner each 30 s; one silent for 90 s is cut loose (a network cut leaves TCP half-open and
   * the socket looking fine), so its close handler can bring it back.
   */
  startHeartbeat(): void {
    this.#pinger = setInterval(() => {
      for (const [agentId, ws] of this.#sockets) {
        if (Date.now() - (this.#heard.get(agentId) ?? 0) > 90_000) ws.terminate();
        else if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping" } satisfies HubToRunner));
      }
    }, 30_000);
    this.#pinger.unref();
  }

  ready(agentId: string): void {
    for (const w of this.#waiters.get(agentId) ?? []) w();
    this.#waiters.delete(agentId);
  }

  detach(agentId: string, ws: WebSocket): void {
    if (this.#sockets.get(agentId) === ws) this.#sockets.delete(agentId);
  }

  send(agentId: string, msg: HubToRunner): boolean {
    const ws = this.#sockets.get(agentId);
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    this.lastSeen.set(agentId, Date.now());
    return true;
  }

  waitFor(agentId: string, timeoutMs: number): Promise<void> {
    if (this.connected(agentId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const current = this.#waiters.get(agentId);
        if (current) {
          const remaining = current.filter((w) => w !== waiter);
          if (remaining.length) this.#waiters.set(agentId, remaining);
          else this.#waiters.delete(agentId);
        }
        reject(new Error("agent 容器启动超时"));
      }, timeoutMs);
      timer.unref?.();
      const list = this.#waiters.get(agentId) ?? [];
      list.push(waiter);
      this.#waiters.set(agentId, list);
    });
  }

  closeAll(): void {
    if (this.#pinger) clearInterval(this.#pinger);
    for (const ws of this.#sockets.values()) ws.close();
  }
}

/** Runtime settings editable from the app (env values are the defaults). */
export type EmojiUse = "none" | "rare" | "some" | "free";

export class Settings {
  #db: Db;
  #secrets: SecretStore;
  #models: ModelRegistry;

  constructor(db: Db, secrets: SecretStore, models: ModelRegistry) {
    this.#db = db;
    this.#secrets = secrets;
    this.#models = models;
  }

  #num(key: string, fallback: number): number {
    const v = Number(kvGet(this.#db, `settings.${key}`));
    return kvGet(this.#db, `settings.${key}`) !== undefined && Number.isFinite(v) ? v : fallback;
  }

  #bool(key: string, fallback: boolean): boolean {
    const v = kvGet(this.#db, `settings.${key}`);
    return v === undefined ? fallback : v === "true";
  }

  /**
   * Model refs: "model@provider", or a bare name for the built-in new-api (like the env defaults). Nothing chosen
   * falls back to the first model whose test passed, then the first model at all.
   */
  defaultModel(): string {
    const chosen = kvGet(this.#db, "settings.defaultModel") || config.defaultModel;
    if (chosen) return this.#models.normalize(chosen);
    const list = this.#models.list();
    return (list.find((m) => m.test?.ok) ?? list[0])?.ref ?? "";
  }

  /** Reflection, diagnosis and supervision follow the default model unless one is chosen for them. */
  reflectModel(): string {
    const chosen = kvGet(this.#db, "settings.reflectModel") || config.reflectModel;
    return chosen ? this.#models.normalize(chosen) : this.defaultModel();
  }

  /** Reasoning effort preselected for new agents (null = the model's default). */
  defaultEffort(): Effort | null {
    const v = kvGet(this.#db, "settings.defaultEffort");
    return v && EffortSchema.safeParse(v).success ? v : null;
  }

  /** Continue runs that were cut off or hit a temporary failure (on unless turned off). */
  autoResume(): boolean {
    return this.#bool("autoResume", true);
  }

  limits(): RunLimits {
    return {
      runTimeoutMinutes: this.#num("runTimeoutMinutes", config.runTimeoutMinutes),
      runWatchdogMinutes: this.#num("runWatchdogMinutes", config.runWatchdogMinutes),
      maxAutoResumes: this.#num("maxAutoResumes", 3),
    };
  }

  /** Agents read page HTML directly when using the browser (on unless turned off). */
  browserHtml(): boolean {
    return this.#bool("browserHtml", true);
  }

  /** Interactive UI in replies (智能界面): off, balanced (default) or rich. */
  intelligentUi(): IntelligentUiLevel {
    const v = kvGet(this.#db, "settings.intelligentUi");
    return INTELLIGENT_UI_LEVELS.find((l) => l === v) ?? "balanced";
  }

  /** How often agents use emoji in replies and artifacts ("free" = no instruction). */
  emojiUse(): EmojiUse {
    const v = kvGet(this.#db, "settings.emojiUse");
    return v === "none" || v === "rare" || v === "some" || v === "free" ? v : "rare";
  }

  /** Keep emoji out of headings and titles (on unless turned off). */
  plainHeadings(): boolean {
    return this.#bool("plainHeadings", true);
  }

  /** Reply-style line for agent instructions, from the emoji settings. */
  emojiNote(): string {
    const use = {
      none: "不要使用 emoji。",
      rare: "少用 emoji：只在确实有助于表达时偶尔用一个，不要拿 emoji 当列表符号或装饰。",
      some: "可以适度使用 emoji 让内容更生动，但不要每行都放。",
      free: "",
    }[this.emojiUse()];
    const headings = this.plainHeadings() && this.emojiUse() !== "none" ? "标题（Markdown 标题，成果、文档和网页的标题）不加 emoji。" : "";
    return use + headings;
  }

  /**
   * How one kind of agent action is approved (设置 → 权限); everything is approved unless chosen otherwise.
   * Values the owner set explicitly under the older settings (one global mode, instance switches) still hold.
   */
  permission(kind: string): ApprovalMode {
    if (!(PERMISSION_KINDS as readonly string[]).includes(kind)) return "ask";
    const k = kind as PermissionKind;
    const valid = (v: string | undefined): v is ApprovalMode => v === "auto" || v === "ask" || (v === "smart" && SMART_KINDS.includes(k));
    const v = kvGet(this.#db, `settings.permission.${k}`);
    if (valid(v)) return v;
    if (k === "host_access") {
      const legacy = kvGet(this.#db, "settings.approvalMode");
      if (valid(legacy)) return legacy;
      if (kvGet(this.#db, "settings.autoApprove") === "true") return "auto";
    }
    if (k === "instance_create" || k === "instance_update") {
      const legacy = kvGet(this.#db, `settings.instanceApproval.${k.slice("instance_".length)}`);
      if (legacy !== undefined) return legacy === "true" ? "ask" : "auto";
    }
    return "auto";
  }

  permissions(): Record<PermissionKind, ApprovalMode> {
    return Object.fromEntries(PERMISSION_KINDS.map((k) => [k, this.permission(k)])) as Record<PermissionKind, ApprovalMode>;
  }

  /** The engine only asks the hub about commands / file edits when some of those need a decision. */
  engineApprovalPolicy(): "auto" | "ask" {
    return this.permission("command") === "auto" && this.permission("file_change") === "auto" ? "auto" : "ask";
  }

  /** Idle minutes before an agent container / desktop is stopped (0 = keep running). */
  agentIdleMinutes(): number {
    return this.#num("agentIdleMinutes", config.agentIdleMinutes);
  }

  desktopIdleMinutes(): number {
    return this.#num("desktopIdleMinutes", config.desktopIdleMinutes);
  }

  /** What idle instances do unless they say otherwise: stop (frees memory) unless chosen otherwise. */
  desktopIdleAction(): IdleAction {
    const v = IdleAction.safeParse(kvGet(this.#db, "settings.desktopIdleAction"));
    return v.success ? v.data : "stop";
  }

  /** Which Android backend new instances use; "auto" picks whatever the host supports. */
  androidBackend(): AndroidBackendSetting {
    const v = kvGet(this.#db, "settings.androidBackend");
    return v === "redroid" || v === "emulator" || v === "off" ? v : "auto";
  }

  instanceLimits(): { total: number; android: number } {
    return { total: this.#num("maxInstances", 10), android: this.#num("maxAndroidInstances", 3) };
  }

  /** Turns that end "done" with the job unfinished get a second look, and the agent is pulled back (on unless turned off). */
  endingReview(): boolean {
    return this.#bool("endingReview", true);
  }

  /** Whether agents need the owner's approval to create / change instances (repairing one never does). */
  instanceApproval(): { create: boolean; update: boolean } {
    return { create: this.permission("instance_create") === "ask", update: this.permission("instance_update") === "ask" };
  }

  reflection(): { enabled: boolean; minToolCalls: number } {
    return { enabled: this.#bool("autoReflect", true), minToolCalls: this.#num("reflectMinToolCalls", 3) };
  }

  /** Which run events push to devices (they always land in the in-app inbox). */
  notifyOn(): Record<NotifyKind, boolean> {
    return {
      done: this.#bool("notify.done", true),
      failed: this.#bool("notify.failed", true),
      approval: this.#bool("notify.approval", true),
      stuck: this.#bool("notify.stuck", true),
      panic: this.#bool("notify.panic", true),
    };
  }

  /** Quiet hours (local time, may wrap past midnight): pushes arrive without sound and Telegram stays silent. */
  quietHours(): { enabled: boolean; start: string; end: string } {
    return {
      enabled: this.#bool("quiet.enabled", false),
      start: kvGet(this.#db, "settings.quiet.start") || "23:00",
      end: kvGet(this.#db, "settings.quiet.end") || "08:00",
    };
  }

  isQuiet(now = new Date()): boolean {
    const q = this.quietHours();
    if (!q.enabled || q.start === q.end) return false;
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    return q.start < q.end ? hm >= q.start && hm < q.end : hm >= q.start || hm < q.end;
  }

  backupKeep(): number {
    return Math.max(1, this.#num("backupKeep", 7));
  }

  newapiAdmin(): { token: string; userId: string } | null {
    const token = this.#secrets.get("settings", "newapiAdminToken") || config.newapi.adminToken;
    if (!token) return null;
    return { token, userId: kvGet(this.#db, "settings.newapiAdminUserId") || config.newapi.adminUserId };
  }

  telegram(): { botToken: string; chatId: string } | null {
    const botToken = this.#secrets.get("settings", "telegramBotToken") || config.telegram.botToken;
    const chatId = kvGet(this.#db, "settings.telegramChatId") || config.telegram.chatId;
    return botToken && chatId ? { botToken, chatId } : null;
  }

  view(): Record<string, unknown> {
    const admin = this.newapiAdmin();
    return {
      defaultModel: this.defaultModel(),
      reflectModel: this.reflectModel(),
      defaultEffort: this.defaultEffort(),
      autoResume: this.autoResume(),
      endingReview: this.endingReview(),
      ...this.limits(),
      browserHtml: this.browserHtml(),
      intelligentUi: this.intelligentUi(),
      emojiUse: this.emojiUse(),
      plainHeadings: this.plainHeadings(),
      permissions: this.permissions(),
      agentIdleMinutes: this.agentIdleMinutes(),
      desktopIdleMinutes: this.desktopIdleMinutes(),
      desktopIdleAction: this.desktopIdleAction(),
      androidBackend: this.androidBackend(),
      maxInstances: this.instanceLimits().total,
      maxAndroidInstances: this.instanceLimits().android,
      autoReflect: this.reflection().enabled,
      reflectMinToolCalls: this.reflection().minToolCalls,
      notifyOn: this.notifyOn(),
      quietHours: this.quietHours(),
      backupKeep: this.backupKeep(),
      modelNameFormat: this.#models.nameFormat(),
      newapiBaseUrl: config.newapi.baseUrl,
      newapiEnabled: this.#models.builtinEnabled(),
      modelSeedError: this.#models.seedError(),
      newapiAdminConfigured: !!admin,
      newapiAdminUserId: admin?.userId ?? config.newapi.adminUserId,
      telegramConfigured: !!this.telegram(),
      telegramChatId: kvGet(this.#db, "settings.telegramChatId") || config.telegram.chatId,
      timezone: config.timezone,
      origins: allowedOrigins(this.#db),
      dataDir: config.dataDir,
    };
  }
}

export async function createHub(opts: { dbPath?: string; webDist?: string; logger?: boolean } = {}): Promise<Hub> {
  if (!config.masterKey) throw new Error("CONSTELLA_MASTER_KEY is required");
  const db = openDb(opts.dbPath ?? config.dbPath);
  const secrets = new SecretStore(db, new SecretBox(config.masterKey));
  const models = new ModelRegistry({ db, secrets, newapiBaseUrl: config.newapi.baseUrl, newapiKey: () => config.newapi.apiKey });
  const settings = new Settings(db, secrets, models);
  const events = new EventStore(db);
  /** Streaming UI blocks (```ui-json) inside replies: parsing, caps, and the stored documents. */
  const ui = new UiStreams(db, events);
  const containers = new Containers();
  const runners = new RunnerGateway();
  const newapi = new NewApi({ baseUrl: config.newapi.baseUrl, admin: () => settings.newapiAdmin() });
  const catalog = new EffortCatalog(db);
  const notifier = new Notifier(db, events, config.vapid, () => settings.telegram(), () => settings.isQuiet());
  let agents!: Agents;
  let credentials!: Credentials;
  let secretCache: { revision: number; values: string[] } | undefined;
  const allSecretValues = () => {
    const revision = secrets.revision() + (credentials?.revision() ?? 0);
    if (secretCache?.revision === revision) return secretCache.values;
    const values = [config.newapi.apiKey, ...models.keys(), ...(credentials ? credentials.secretValues() : []), ...(agents ? agents.list(true).flatMap((a) => agents.secretValues(a.id)) : [])];
    secretCache = { revision, values };
    return values;
  };
  events.secretValues = allSecretValues;
  const knowledge = new Knowledge(db, events, allSecretValues);
  knowledge.ensureShared();
  agents = new Agents({ db, secrets, knowledge, defaultModel: () => settings.defaultModel(), defaultEffort: () => settings.defaultEffort() });

  const ensureRunner = async (agentId: string) => {
    const agent = agents.get(agentId);
    agents.writeEngineConfig(agent, newapi.baseUrl, models.parse(agent.model).model);
    await containers.ensureAgent({ agentId, env: agents.containerEnv(agentId, config.newapi.apiKey), hostAccess: !!agent.host_access });
    runners.lastSeen.set(agentId, Date.now());
    await runners.waitFor(agentId, 90_000);
  };
  /**
   * A runner went away while it still had runs (container crashed, removed, or never came back
   * after a hub restart): bring it back so its hello lets the run manager continue them. When it
   * won't come back by itself, the container is rebuilt.
   */
  const reviveIfStranded = (agentId: string, delayMs: number) =>
    setTimeout(() => {
      if (!settings.autoResume() || runners.connected(agentId) || recovery.repairing(agentId)) return;
      const stranded = db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status IN ('running','waiting_approval','paused_by_user') LIMIT 1").get(agentId);
      if (!stranded) return;
      void ensureRunner(agentId).catch(async (err) => {
        const error = err instanceof Error ? err.message : String(err);
        audit(db, "system", "runner.revive_failed", { agentId, error });
        await recovery.repairRunner(agentId, error).catch((e) => audit(db, "system", "runner.repair_failed", { agentId, error: e instanceof Error ? e.message : String(e) }));
      });
    }, delayMs).unref();

  let recovery!: Recovery;
  const runs = new RunManager({
    db,
    events,
    ui,
    ensureRunner,
    sendToRunner: (agentId, msg) => runners.send(agentId, msg),
    startPayload: (agentId) => {
      const a = agents.get(agentId);
      const desktopNote =
        desktops.agentNote(agentId) +
        (settings.browserHtml()
          ? "\n    读网页上的信息（正文、列表、表格、价格、链接地址、表单当前值等）时，优先用 browser_html 直接读取 HTML：比截图更快更准，一次拿到整页，不用来回滚动截图；页面很长时用 selector 只读需要的部分。browser_snapshot 适合找要点击的元素；要看布局、图片、图表或验证码时再截图。几种方式按需配合。"
          : "");
      const credentialNote =
        "credentials_fill：登录需要用户名、密码或一次性验证码时用它：先从主人的密码库取，没有就在聊天里弹出输入框请主人输入，值由平台直接填进页面，不会返回给你。不要自己向主人要密码，也不要让主人把密码发在聊天里；主人暂时没提供就把能做的做完，说明在等什么凭据后正常结束这一轮（不算失败）。" +
        (credentials.connections().length
          ? "\n  - credentials_list / credentials_request / credentials_status / credentials_read：主人的密码库（凭据 / 隐私）里的登录凭据。只有需要读出凭据值本身（不是填进网页）时才用：先用 credentials_list 找到条目，再用 credentials_request 申请，写清用途和目标（主人指定的审批 agent 会审核，批准后 10 分钟内用 credentials_read 读一次）。只要真正需要的字段；凭据值不要写进文件、日志或记忆。"
          : "");
      return {
        model: a.model,
        effort: a.effort ?? undefined,
        instructions: agents.instructions(a, { desktopNote, credentialNote, uiNote: intelligentUiNote(settings.intelligentUi()), styleNote: settings.emojiNote() }),
        approvalPolicy: settings.engineApprovalPolicy(),
        skillRoots: ["/home/agent/knowledge/skills", "/shared/skills"],
      };
    },
    notify: (title, body, url, kind) => void notifier.send(title, body, url, { push: settings.notifyOn()[kind] }),
    resolveModel: (ref) => models.resolve(ref),
    fitEffort: (model, effort) => catalog.fit(model, effort),
    autoResume: () => settings.autoResume(),
    limits: () => settings.limits(),
    permission: (kind) => settings.permission(kind),
    repairRunner: (agentId, error) => recovery.repairRunner(agentId, error),
    incident: (input) => void recovery.file(input),
    reviewDone: (run) => recovery.reviewDone(run),
  });
  credentials = new Credentials({ db, secrets, events, runs });
  const hostcaps = new HostCapabilities({ docker: containers.docker, androidBackend: () => settings.androidBackend() });
  const desktops = new Desktops({
    db,
    events,
    containers,
    runs,
    caps: hostcaps,
    settings: {
      idleMinutes: () => settings.desktopIdleMinutes(),
      idleAction: () => settings.desktopIdleAction(),
      maxInstances: () => settings.instanceLimits().total,
      maxAndroid: () => settings.instanceLimits().android,
    },
  });
  recovery = new Recovery({
    db,
    events,
    runs,
    agents,
    containers,
    llm: models,
    model: () => settings.reflectModel(),
    notify: (title, body, url, kind) => void notifier.send(title, body, url, { push: settings.notifyOn()[kind] }),
    limits: () => settings.limits(),
    ensureRunner,
    connected: (agentId) => runners.connected(agentId),
    secretValues: allSecretValues,
    desktops,
    hostcaps,
    endingReview: () => settings.endingReview(),
  });
  const learning = new Learning({ db, events, knowledge, llm: models, model: () => settings.reflectModel(), auto: () => settings.reflection() });
  const reflect = new Reflect({ db, llm: models, model: () => settings.reflectModel() });
  const scheduler = new Scheduler(db, events);
  const artifacts = new Artifacts({ db, events });

  runs.onFinished((run) => desktops.releaseRun(run.id));
  runs.onFinished((run) => learning.maybeReflect(run));

  // Skill usage: the engine reads SKILL.md through the shell before applying a skill.
  events.bus.on("message", (m) => {
    if (m.kind !== "event" || m.event.type !== "tool.started") return;
    const cmd = JSON.stringify(m.event.input ?? "");
    const names = [...cmd.matchAll(/skills\/([a-z0-9][a-z0-9-]{1,46}[a-z0-9])\/SKILL\.md/g)].map((x) => x[1]!);
    if (names.length) knowledge.recordSkillUse(m.event.agentId, names);
  });

  scheduler.on("notify", async (s) => {
    const p = JSON.parse(s.payload) as { title: string; body: string };
    const r = await notifier.send(p.title, p.body, "/", { urgent: true });
    return { ok: r.push > 0 || r.telegram, detail: `推送 ${r.push} 台设备${r.telegram ? "，Telegram 已发送" : ""}` };
  });
  scheduler.on("agent_prompt", async (s) => {
    const p = JSON.parse(s.payload) as { text: string };
    const r = await runs.send({ agentId: s.agent_id!, text: `［定时任务：${s.name}］\n${p.text}`, source: "schedule" });
    return { ok: true, runId: r.runId, detail: "已启动" };
  });
  scheduler.ensureSystem("sys-curate", "每周整理记忆和技能", "0 4 * * 1");
  scheduler.on("sys-curate", async () => {
    await learning.curateAll();
    return { ok: true };
  });
  scheduler.ensureSystem("sys-backup", "每日备份", "30 3 * * *");

  const backup = async (): Promise<string> => {
    fs.mkdirSync(config.backupsDir, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, "-");
    const tmpDb = path.join(config.backupsDir, `db-${stamp}.sqlite`);
    db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
    const out = path.join(config.backupsDir, `constella-${stamp}.tar.gz`);
    const rel = (p: string) => path.relative(config.dataDir, p);
    const knowledgeDirs = agents
      .list(true)
      .map((a) => rel(knowledge.agentRepo(a.id)))
      .filter((p) => fs.existsSync(path.join(config.dataDir, p)));
    const artifactDir = fs.existsSync(config.artifactsDir) ? [rel(config.artifactsDir)] : [];
    execFileSync("tar", ["-czf", out, "-C", config.dataDir, rel(tmpDb), "shared", ...knowledgeDirs, ...artifactDir]);
    fs.rmSync(tmpDb);
    const all = fs.readdirSync(config.backupsDir).filter((f) => f.startsWith("constella-")).sort();
    for (const f of all.slice(0, Math.max(0, all.length - settings.backupKeep()))) fs.rmSync(path.join(config.backupsDir, f));
    return out;
  };
  scheduler.on("sys-backup", async () => ({ ok: true, detail: path.basename(await backup()) }));

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(rateLimit, { global: false });

  const auth = new Auth(db);
  const office = new OfficeService({ db, secrets, docker: containers.docker });
  office.startIdleStop();
  const perf = new PerfMonitor({ docker: containers.docker });
  const hub: Hub = {
    app,
    office,
    perf,
    db,
    auth,
    secrets,
    events,
    ui,
    agents,
    runs,
    artifacts,
    credentials,
    recovery,
    knowledge,
    learning,
    reflect,
    desktops,
    hostcaps,
    containers,
    scheduler,
    notifier,
    newapi,
    models,
    catalog,
    runners,
    settings,
    backup,
    reviveIfStranded: (agentId, delayMs) => void reviveIfStranded(agentId, delayMs),
    close: async () => {
      scheduler.stop();
      perf.stop();
      credentials.close();
      runs.stopWatchdog();
      recovery.stop();
      runners.closeAll();
      await app.close();
      db.close();
    },
  };

  // Runner connections from agent containers.
  app.get("/api/runner", { websocket: true }, (socket, req) => {
    const auth = String(req.headers.authorization ?? "");
    const agent = auth.startsWith("Bearer ") ? agents.byToken(auth.slice(7)) : undefined;
    if (!agent) {
      socket.close(4001, "unauthorized");
      return;
    }
    runners.attach(agent.id, socket);
    socket.on("message", (raw: Buffer) => {
      let msg;
      try {
        msg = RunnerToHubSchema.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      runners.heard(agent.id);
      if (msg.t !== "pong") runners.lastSeen.set(agent.id, Date.now());
      switch (msg.t) {
        case "hello":
          runs.onRunnerHello(agent.id, msg.activeRuns);
          runners.ready(agent.id);
          events.publish("agent", { id: agent.id, connected: true });
          break;
        case "event":
          runs.onRunnerEvent(agent.id, msg.event as unknown as RunnerEvent);
          break;
        case "thread":
          runs.onThread(agent.id, msg.runId, msg.threadId);
          break;
        case "activity":
          runs.touch(agent.id, msg.runId);
          break;
        case "models":
          catalog.update(msg.models);
          break;
        case "turn_done": {
          const run = runs.get(msg.runId);
          if (run && run.agent_id === agent.id) runs.engineDone(msg.runId, msg.status, msg.error);
          break;
        }
      }
    });
    socket.on("close", () => {
      runners.detach(agent.id, socket);
      events.publish("agent", { id: agent.id, connected: false });
      reviveIfStranded(agent.id, 5_000);
    });
  });

  registerMcp(app, {
    db,
    agents,
    runs,
    knowledge,
    desktops,
    hostcaps,
    notifier,
    scheduler,
    containers,
    artifacts,
    credentials,
    recovery,
    browserHtml: () => settings.browserHtml(),
    instanceApproval: () => settings.instanceApproval(),
  });
  registerRoutes(hub);
  registerOfficeProxy(hub);

  const webDist = opts.webDist ?? process.env.CONSTELLA_WEB_DIST ?? path.resolve(import.meta.dirname, "../../web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      maxAge: 3_600_000,
      setHeaders: (res, filePath) => {
        if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(filePath)) res.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/mcp") && !req.url.startsWith("/office-ds/")) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      }
      // A share that reached the server (the service worker wasn't running yet): open the page, which explains.
      if (req.method === "POST" && req.url.split("?")[0] === "/share") return reply.redirect("/share", 303);
      return reply.code(404).send({ error: "not found" });
    });
  }

  // Idle agent containers are stopped; they restart on the next message.
  const idleTimer = setInterval(async () => {
    const idle = settings.agentIdleMinutes();
    if (idle <= 0) return;
    const cutoff = Date.now() - idle * 60_000;
    for (const a of agents.list()) {
      const active = db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled') LIMIT 1").get(a.id);
      if (active || (runners.lastSeen.get(a.id) ?? 0) > cutoff) continue;
      const name = containers.agentName(a.id);
      if ((await containers.state(name).catch(() => "missing")) === "running") {
        await containers.stop(name).catch(() => {});
        events.publish("agent", { id: a.id, connected: false, sleeping: true });
      }
    }
  }, 60_000);
  idleTimer.unref();

  return hub;
}


export async function bootHub(hub: Hub): Promise<void> {
  await hub.containers.ensureNetwork().catch((err) => console.error("docker network", err));
  hub.runs.recoverOnBoot();
  hub.runs.startWatchdog();
  hub.recovery.start();
  hub.runners.startHeartbeat();
  hub.desktops.startReaper();
  hub.perf.start();
  void hub.hostcaps.refresh().catch((err) => console.error("host capability probe", err));
  hub.scheduler.start();
  void hub.models.seed();
  // Runners that don't reconnect by themselves after a hub restart (container gone) get brought back.
  const pending = hub.db.prepare("SELECT DISTINCT agent_id FROM runs WHERE status IN ('running','waiting_approval','paused_by_user')").all() as { agent_id: string }[];
  for (const { agent_id } of pending) hub.reviveIfStranded(agent_id, 20_000);
  // Runs whose runner never comes back after a hub restart can't finish on their own.
  setTimeout(() => {
    const rows = hub.db
      .prepare("SELECT id, agent_id FROM runs WHERE status IN ('running','waiting_approval','paused_by_user')")
      .all() as { id: string; agent_id: string }[];
    for (const r of rows) if (!hub.runners.connected(r.agent_id)) hub.runs.cutOff(r.id, "agent 未能重新连接，任务中断");
  }, 180_000).unref();
}
