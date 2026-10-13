import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { RunnerToHubSchema, type DesktopPolicy, type HubToRunner, type RunnerEvent } from "@constella/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { Agents } from "./agents.ts";
import { Auth } from "./auth.ts";
import { EffortCatalog } from "./catalog.ts";
import { config, nowIso } from "./config.ts";
import { Containers } from "./containers.ts";
import { kvGet, openDb, type Db } from "./db.ts";
import { Desktops } from "./desktops.ts";
import { EventStore } from "./events.ts";
import { Knowledge } from "./knowledge.ts";
import { Learning, defaultReflectModel } from "./learning.ts";
import { registerMcp } from "./mcp.ts";
import { NewApi } from "./newapi.ts";
import { Notifier } from "./notify.ts";
import { registerRoutes } from "./routes.ts";
import { RunManager } from "./runs.ts";
import { Scheduler } from "./scheduler.ts";
import { Reflect } from "./reflect.ts";
import type { ApprovalMode } from "./safety.ts";
import { SecretBox, SecretStore } from "./secrets.ts";

export interface Hub {
  app: FastifyInstance;
  db: Db;
  auth: Auth;
  secrets: SecretStore;
  events: EventStore;
  agents: Agents;
  runs: RunManager;
  knowledge: Knowledge;
  learning: Learning;
  reflect: Reflect;
  desktops: Desktops;
  containers: Containers;
  scheduler: Scheduler;
  notifier: Notifier;
  newapi: NewApi;
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
  lastSeen = new Map<string, number>();

  connected(agentId: string): boolean {
    return this.#sockets.get(agentId)?.readyState === 1;
  }

  attach(agentId: string, ws: WebSocket): void {
    this.#sockets.get(agentId)?.close(4000, "replaced");
    this.#sockets.set(agentId, ws);
    this.lastSeen.set(agentId, Date.now());
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
      const timer = setTimeout(() => reject(new Error("agent 容器启动超时")), timeoutMs);
      const list = this.#waiters.get(agentId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#waiters.set(agentId, list);
    });
  }

  closeAll(): void {
    for (const ws of this.#sockets.values()) ws.close();
  }
}

/** Runtime settings editable from the app (env values are the defaults). */
export class Settings {
  #db: Db;
  #secrets: SecretStore;

  constructor(db: Db, secrets: SecretStore) {
    this.#db = db;
    this.#secrets = secrets;
  }

  defaultModel(): string {
    return kvGet(this.#db, "settings.defaultModel") || config.defaultModel;
  }

  reflectModel(): string {
    return defaultReflectModel(this.#db);
  }

  /** Continue runs a restart cut off (on unless turned off). */
  autoResume(): boolean {
    return kvGet(this.#db, "settings.autoResume") !== "false";
  }

  /** How approvals are decided; "smart" (ask only for destructive actions) unless chosen otherwise. */
  approvalMode(): ApprovalMode {
    const v = kvGet(this.#db, "settings.approvalMode");
    if (v === "ask" || v === "smart" || v === "auto") return v;
    return kvGet(this.#db, "settings.autoApprove") === "true" ? "auto" : "smart";
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
      autoResume: this.autoResume(),
      approvalMode: this.approvalMode(),
      newapiBaseUrl: config.newapi.baseUrl,
      newapiAdminConfigured: !!admin,
      newapiAdminUserId: admin?.userId ?? config.newapi.adminUserId,
      telegramConfigured: !!this.telegram(),
      telegramChatId: kvGet(this.#db, "settings.telegramChatId") || config.telegram.chatId,
      timezone: config.timezone,
      origins: config.origins,
    };
  }
}

export async function createHub(opts: { dbPath?: string; webDist?: string; logger?: boolean } = {}): Promise<Hub> {
  if (!config.masterKey) throw new Error("CONSTELLA_MASTER_KEY is required");
  const db = openDb(opts.dbPath ?? config.dbPath);
  const secrets = new SecretStore(db, new SecretBox(config.masterKey));
  const settings = new Settings(db, secrets);
  const events = new EventStore(db);
  const containers = new Containers();
  const runners = new RunnerGateway();
  const newapi = new NewApi({
    baseUrl: config.newapi.baseUrl,
    apiKey: () => config.newapi.apiKey,
    admin: () => settings.newapiAdmin(),
  });
  const catalog = new EffortCatalog(db);
  const notifier = new Notifier(db, events, config.vapid, () => settings.telegram());
  let agents!: Agents;
  const allSecretValues = () => [config.newapi.apiKey, ...(agents ? agents.list(true).flatMap((a) => agents.secretValues(a.id)) : [])];
  const knowledge = new Knowledge(db, events, allSecretValues);
  knowledge.ensureShared();
  agents = new Agents({ db, secrets, knowledge, defaultModel: () => settings.defaultModel() });

  const ensureRunner = async (agentId: string) => {
    const agent = agents.get(agentId);
    agents.writeEngineConfig(agent, newapi.baseUrl);
    await containers.ensureAgent({ agentId, env: agents.containerEnv(agentId, config.newapi.apiKey), hostAccess: !!agent.host_access });
    runners.lastSeen.set(agentId, Date.now());
    await runners.waitFor(agentId, 90_000);
  };
  /**
   * A runner went away while it still had runs (container crashed, removed, or never came back
   * after a hub restart): bring it back so its hello lets the run manager continue them.
   */
  const reviveIfStranded = (agentId: string, delayMs: number) =>
    setTimeout(() => {
      if (!settings.autoResume() || runners.connected(agentId)) return;
      const stranded = db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status IN ('running','waiting_approval','paused_by_user') LIMIT 1").get(agentId);
      if (stranded) void ensureRunner(agentId).catch((err) => console.error("revive runner", agentId, err));
    }, delayMs).unref();

  const runs = new RunManager({
    db,
    events,
    ensureRunner,
    sendToRunner: (agentId, msg) => runners.send(agentId, msg),
    startPayload: (agentId) => {
      const a = agents.get(agentId);
      const policy = JSON.parse(a.desktop_policy) as DesktopPolicy;
      const desktopNote =
        policy.mode === "none"
          ? "你没有分配桌面，不能使用 desktop_* / browser_* 工具；需要上网时用命令行（curl 等）。"
          : "desktop_* / browser_*：操作你的图形桌面和浏览器。网页任务优先用 browser_*（按页面结构操作，更可靠），其他程序用 desktop_screenshot + desktop_action。遇到登录、验证码、支付等必须由用户本人完成的步骤，调用 desktop_request_help。";
      return {
        model: a.model,
        effort: a.effort ?? undefined,
        instructions: agents.instructions(a, { desktopNote }),
        approvalPolicy: a.approval_policy,
        skillRoots: ["/home/agent/knowledge/skills", "/shared/skills"],
      };
    },
    notify: (title, body, url) => void notifier.send(title, body, url),
    fitEffort: (model, effort) => catalog.fit(model, effort),
    autoResume: () => settings.autoResume(),
    approvalMode: () => settings.approvalMode(),
  });
  const desktops = new Desktops({ db, events, containers, runs });
  const learning = new Learning({ db, events, knowledge, newapi, model: () => settings.reflectModel() });
  const reflect = new Reflect({ db, newapi, model: () => settings.reflectModel() });
  const scheduler = new Scheduler(db, events);

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
    execFileSync("tar", ["-czf", out, "-C", config.dataDir, rel(tmpDb), "shared", ...knowledgeDirs]);
    fs.rmSync(tmpDb);
    const all = fs.readdirSync(config.backupsDir).filter((f) => f.startsWith("constella-")).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 7))) fs.rmSync(path.join(config.backupsDir, f));
    return out;
  };
  scheduler.on("sys-backup", async () => ({ ok: true, detail: path.basename(await backup()) }));

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(rateLimit, { global: false });

  const auth = new Auth(db);
  const hub: Hub = {
    app,
    db,
    auth,
    secrets,
    events,
    agents,
    runs,
    knowledge,
    learning,
    reflect,
    desktops,
    containers,
    scheduler,
    notifier,
    newapi,
    catalog,
    runners,
    settings,
    backup,
    reviveIfStranded: (agentId, delayMs) => void reviveIfStranded(agentId, delayMs),
    close: async () => {
      scheduler.stop();
      runs.stopWatchdog();
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
      runners.lastSeen.set(agent.id, Date.now());
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

  registerMcp(app, { db, agents, runs, knowledge, desktops, notifier, scheduler, containers });
  registerRoutes(hub);

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
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/mcp")) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  // Idle agent containers are stopped; they restart on the next message.
  const idleTimer = setInterval(async () => {
    const cutoff = Date.now() - config.agentIdleMinutes * 60_000;
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
  hub.desktops.startReaper();
  hub.scheduler.start();
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
