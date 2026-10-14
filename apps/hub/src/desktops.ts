import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DesktopOptions, type DesktopKind, type DesktopLease, type IdleAction } from "@constella/protocol";
import { chromium, type Browser, type Page } from "playwright-core";
import type { WebSocket } from "ws";
import { config, newId, nowIso } from "./config.ts";
import { audit, type Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import { ANDROID_STOP_SECONDS, type ContainerInfo, type Containers, type DesktopSpec } from "./containers.ts";
import type { HostCapabilities } from "./hostcaps.ts";
import type { RunManager } from "./runs.ts";

export interface DesktopRow {
  id: string;
  name: string;
  kind: DesktopKind;
  /** JSON DesktopOptions. */
  options: string;
  lease: string;
  /** Unused since agents bind instances themselves (agents.desktop_policy). */
  pinned_agent_id: string | null;
  created_at: string;
  last_used_at: string;
}

export interface DesktopAction {
  type: "click" | "double_click" | "right_click" | "middle_click" | "move" | "drag" | "type" | "key" | "scroll" | "wait";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  keys?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  seconds?: number;
}

/** Tool families: desktop_* drive any instance's screen, browser_* need one with a browser. */
export type ToolFamily = "screen" | "web";

export const KIND_LABEL: Record<DesktopKind, string> = { browser: "浏览器", desktop: "Linux 桌面", android: "安卓" };

const WEB_KINDS: readonly DesktopKind[] = ["browser", "desktop"];
const SIZE: Record<DesktopKind, { width: number; height: number }> = {
  browser: { width: 1280, height: 800 },
  desktop: { width: 1280, height: 800 },
  android: { width: 720, height: 1280 },
};
const HELP_TIMEOUT_MS = 15 * 60_000;

export interface InstanceSettings {
  idleMinutes: () => number;
  idleAction: () => IdleAction;
  maxInstances: () => number;
  maxAndroid: () => number;
}

/** Instance ids an agent is bound to, from its stored policy (old none / fixed / on_demand shapes included). */
export function boundIds(policy: string | undefined): string[] {
  try {
    const p = JSON.parse(policy ?? "{}") as { desktopIds?: unknown; mode?: string; desktopId?: string };
    if (Array.isArray(p.desktopIds)) return p.desktopIds.filter((x): x is string => typeof x === "string");
    return p.mode === "fixed" && p.desktopId ? [p.desktopId] : [];
  } catch {
    return [];
  }
}

/** How an instance is doing, from its containers and its control service (not just "the container is up"). */
export interface InstanceHealth {
  /** Usable now, or deliberately paused / stopped (it starts on first use). */
  ok: boolean;
  state: "running" | "paused" | "stopped" | "missing" | "starting" | "broken";
  /** One line saying what is wrong, when it isn't ok. */
  problem?: string;
  /** Keeps exiting and being restarted by Docker: it won't come up by itself. */
  crashLoop: boolean;
  /** The evidence: container states and restart counts, the control service's answer, telling log lines. */
  detail: string;
}

export interface RepairResult {
  ok: boolean;
  steps: string[];
  before: InstanceHealth;
  after: InstanceHealth;
}

/** Log lines worth showing when an instance misbehaves. */
const TELLING = /FATAL|ERROR|panic|Killed|Out of memory|hanging thread|timed out/i;

/**
 * Lock files the emulator leaves in its virtual device when it is killed instead of shut down. Only safe to
 * remove while the emulator isn't running; returns the names removed.
 */
export function clearStaleLocks(avdDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(avdDir).filter((n) => n.endsWith(".lock") || n.includes(".lock.tmp-"));
  } catch {
    return [];
  }
  for (const n of names) fs.rmSync(path.join(avdDir, n), { recursive: true, force: true });
  return names;
}

export type DesktopErrorCode = "not_found" | "unavailable" | "limit" | "busy" | "invalid" | "confirm";

export class DesktopError extends Error {
  readonly code: DesktopErrorCode;

  constructor(message: string, code: DesktopErrorCode = "invalid") {
    super(message);
    this.code = code;
  }
}

/**
 * Instances (bare browser, Linux desktop, Android): container lifecycle including idle pause/stop, single-holder
 * leases, which instance each run is working on, takeover/hand-back, and control and browser access.
 */
export class Desktops {
  #db: Db;
  #events: EventStore;
  #containers: Containers;
  #runs: RunManager;
  #caps: HostCapabilities | null;
  #settings: InstanceSettings;
  #browsers = new Map<string, Browser>();
  /** Resolvers waiting for the human to hand a desktop back. */
  #handbackWaiters = new Map<string, ((note: string) => void)[]>();
  /** Agent lease displaced by a takeover, restored on hand-back. */
  #displaced = new Map<string, Extract<DesktopLease, { holder: "agent" }>>();
  /** Open requests for the owner to take over, by desktop; their progress shows up in the run's chat. */
  #help = new Map<string, { helpId: string; runId: string }>();
  /** The instance each run's desktop_* / browser_* calls go to. */
  #current = new Map<string, Partial<Record<ToolFamily, string>>>();
  /** Open VNC viewers per instance; watched instances aren't idled. */
  #viewers = new Map<string, number>();
  /** Instances being started or repaired right now (a booting instance isn't broken). */
  #starting = new Set<string>();
  #repairs = new Map<string, Promise<RepairResult>>();
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: {
    db: Db;
    events: EventStore;
    containers: Containers;
    runs: RunManager;
    caps?: HostCapabilities;
    settings?: Partial<InstanceSettings>;
  }) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#containers = deps.containers;
    this.#runs = deps.runs;
    this.#caps = deps.caps ?? null;
    this.#settings = {
      idleMinutes: () => config.desktopIdleMinutes,
      idleAction: () => "pause",
      maxInstances: () => 10,
      maxAndroid: () => 3,
      ...deps.settings,
    };
  }

  rows(): DesktopRow[] {
    return this.#db.prepare("SELECT * FROM desktops ORDER BY created_at").all() as unknown as DesktopRow[];
  }

  row(id: string): DesktopRow {
    const r = this.#db.prepare("SELECT * FROM desktops WHERE id = ?").get(id) as DesktopRow | undefined;
    if (!r) throw new DesktopError("实例不存在", "not_found");
    return r;
  }

  lease(id: string): DesktopLease {
    return JSON.parse(this.row(id).lease) as DesktopLease;
  }

  options(r: DesktopRow): DesktopOptions {
    const parsed = DesktopOptions.safeParse(JSON.parse(r.options || "{}"));
    return parsed.success ? parsed.data : {};
  }

  /** Options resolved against the kind's defaults, as the containers get them. */
  spec(r: DesktopRow): DesktopSpec {
    const o = this.options(r);
    return {
      desktopId: r.id,
      kind: r.kind,
      width: o.width ?? SIZE[r.kind].width,
      height: o.height ?? SIZE[r.kind].height,
      dpi: o.dpi ?? 320,
      backend: o.backend ?? "redroid",
      armTranslation: !!o.armTranslation,
      googlePlay: !!o.googlePlay,
    };
  }

  /** When and how this instance goes idle: its own setting, else the global one. */
  idle(r: DesktopRow): { action: IdleAction; minutes: number } {
    const o = this.options(r);
    return { action: o.idleAction ?? this.#settings.idleAction(), minutes: o.idleMinutes ?? this.#settings.idleMinutes() };
  }

  /** e.g. "工作浏览器（浏览器，id dt-x）" */
  describe(r: DesktopRow): string {
    return `${r.name}（${KIND_LABEL[r.kind]}，id ${r.id}）`;
  }

  /** The instance part of an agent's instructions: what it is bound to, what it can create, which tools fit. */
  agentNote(agentId: string): string {
    const bound = this.boundTo(agentId);
    const caps = this.#caps?.snapshot();
    const creatable = (Object.keys(KIND_LABEL) as DesktopKind[]).filter((k) => !caps || caps.kinds[k].ok).map((k) => KIND_LABEL[k]);
    return [
      "实例（instance_* / browser_* / desktop_* / android_*）：平台提供三类图形实例——纯浏览器、Linux 桌面、安卓。",
      bound.length ? `    绑定给你的实例：${bound.map((r) => this.describe(r)).join("；")}。` : "    目前没有实例绑定给你。",
      `    instance_list 查看实例和状态；instance_use 切换当前操作的实例；instance_create 新建实例（自动绑定给你${creatable.length ? `，这台服务器能建：${creatable.join("、")}` : "；这台服务器目前建不了任何实例"}）；instance_update 修改配置；instance_restart 修复卡住或没响应的实例（重启并确认恢复，不需要审批）。新建和修改可能需要主人审批。`,
      "    实例没响应、截图或 android_ui 超时、报错里带「实例诊断」时：先 instance_restart；修不好就 get_help（平台维修员能看到容器日志并动手修），或用 instance_create / instance_use 换一台继续。不要因为实例出故障就结束任务。",
      "    browser_*：操作浏览器或 Linux 桌面实例里的浏览器（按页面结构，更可靠），网页任务优先用它。desktop_*：截图和键鼠操作当前实例的屏幕（安卓上 click 是点按、drag 是滑动，key 支持 back/home/recents）。android_ui 读取安卓界面结构，android_apps 列出或安装 App。",
      "    遇到登录、验证码、扫码、支付等必须由用户本人完成的步骤，调用 desktop_request_help。",
    ].join("\n");
  }

  /** Agents bound to an instance. */
  agentIds(id: string): string[] {
    const agents = this.#db.prepare("SELECT id, desktop_policy FROM agents WHERE archived = 0").all() as { id: string; desktop_policy: string }[];
    return agents.filter((a) => boundIds(a.desktop_policy).includes(id)).map((a) => a.id);
  }

  /** The instances an agent may use, in its order of preference. */
  boundTo(agentId: string): DesktopRow[] {
    const a = this.#db.prepare("SELECT desktop_policy FROM agents WHERE id = ?").get(agentId) as { desktop_policy: string } | undefined;
    const rows = new Map(this.rows().map((r) => [r.id, r]));
    return boundIds(a?.desktop_policy).flatMap((id) => rows.get(id) ?? []);
  }

  /** Bind (or unbind) an instance for the given agents, leaving their other bindings alone. */
  setAgents(id: string, agentIds: string[]): void {
    const agents = this.#db.prepare("SELECT id, desktop_policy FROM agents").all() as { id: string; desktop_policy: string }[];
    const update = this.#db.prepare("UPDATE agents SET desktop_policy = ? WHERE id = ?");
    for (const a of agents) {
      const ids = boundIds(a.desktop_policy);
      const want = agentIds.includes(a.id);
      if (want === ids.includes(id)) continue;
      update.run(JSON.stringify({ desktopIds: want ? [...ids, id] : ids.filter((x) => x !== id) }), a.id);
    }
  }

  async list(): Promise<(Omit<DesktopRow, "options"> & { options: DesktopOptions; state: string; leaseInfo: DesktopLease; agentIds: string[]; viewers: number })[]> {
    return Promise.all(
      this.rows().map(async (r) => ({
        ...r,
        options: this.options(r),
        state: await this.state(r.id),
        leaseInfo: JSON.parse(r.lease),
        agentIds: this.agentIds(r.id),
        viewers: this.#viewers.get(r.id) ?? 0,
      })),
    );
  }

  /** Container state of the instance's screen (for Android: the bridge; a stopped device shows up as not running). */
  async state(id: string): Promise<string> {
    const r = this.row(id);
    let screen = await this.#containers.state(this.#containers.desktopName(id)).catch(() => "error");
    // Docker says "starting" until its first health check passes (up to 15 s); the control API answers sooner.
    if (screen === "starting" && (await this.#healthy(id, 1500))) screen = "running";
    if (r.kind !== "android" || screen !== "running") return screen;
    const device = await this.#containers.state(this.#containers.androidName(id)).catch(() => "error");
    return device === "running" ? "running" : device === "paused" ? "paused" : "starting";
  }

  async create(input: { name: string; kind: DesktopKind; options?: DesktopOptions }): Promise<DesktopRow> {
    const rows = this.rows();
    if (rows.length >= this.#settings.maxInstances()) throw new DesktopError(`实例数量已达上限（${this.#settings.maxInstances()} 个），可以在设置里调整`, "limit");
    if (input.kind === "android" && rows.filter((r) => r.kind === "android").length >= this.#settings.maxAndroid())
      throw new DesktopError(`安卓实例数量已达上限（${this.#settings.maxAndroid()} 个），可以在设置里调整`, "limit");
    const options = await this.#checkOptions(input.kind, DesktopOptions.parse(input.options ?? {}), null);
    const row: DesktopRow = {
      id: newId("dt").toLowerCase().replace(/_/g, "-"),
      name: input.name,
      kind: input.kind,
      options: JSON.stringify(options),
      lease: JSON.stringify({ holder: "none" }),
      pinned_agent_id: null,
      created_at: nowIso(),
      last_used_at: nowIso(),
    };
    this.#db
      .prepare("INSERT INTO desktops (id, name, kind, options, lease, pinned_agent_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.kind, row.options, row.lease, row.pinned_agent_id, row.created_at, row.last_used_at);
    this.#events.publish("desktop", { id: row.id });
    return row;
  }

  /**
   * Change name and/or options. A running instance restarts to apply new options. Switching Google Play on an
   * emulator instance replaces its virtual device (data is lost) and needs `confirmDataLoss`.
   */
  async update(id: string, patch: { name?: string; options?: DesktopOptions }, opts: { confirmDataLoss?: boolean } = {}): Promise<{ restarted: boolean; wiped: boolean }> {
    const r = this.row(id);
    if (patch.name !== undefined) this.#db.prepare("UPDATE desktops SET name = ? WHERE id = ?").run(patch.name, id);
    let restarted = false;
    let wiped = false;
    if (patch.options) {
      const cur = this.options(r);
      const next = await this.#checkOptions(r.kind, { ...cur, ...DesktopOptions.parse(patch.options), backend: cur.backend }, cur);
      const before = this.spec(r);
      const after = this.spec({ ...r, options: JSON.stringify(next) });
      wiped = r.kind === "android" && after.backend === "emulator" && before.googlePlay !== after.googlePlay;
      if (wiped && !opts.confirmDataLoss) throw new DesktopError("切换 Google Play 会重建这台模拟器，里面的数据会被清空，需要确认", "confirm");
      this.#db.prepare("UPDATE desktops SET options = ? WHERE id = ?").run(JSON.stringify(next), id);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const state = await this.state(id);
      if (wiped) {
        await this.stop(id);
        fs.rmSync(path.join(config.desktopsDir, id, "avd"), { recursive: true, force: true });
      }
      if (changed && (state === "running" || state === "paused" || state === "starting")) {
        await this.restart(id);
        restarted = true;
      }
    }
    this.#events.publish("desktop", { id });
    return { restarted, wiped };
  }

  /** Validate kind-specific options against what the host can do; fills in the Android backend on creation. */
  async #checkOptions(kind: DesktopKind, o: DesktopOptions, existing: DesktopOptions | null): Promise<DesktopOptions> {
    const caps = this.#caps ? await this.#caps.get() : null;
    if (!existing && caps && !caps.kinds[kind].ok) throw new DesktopError(`不能新建${KIND_LABEL[kind]}实例：${caps.kinds[kind].reason ?? "不可用"}`, "unavailable");
    if (kind !== "android") return { width: o.width, height: o.height, idleAction: o.idleAction, idleMinutes: o.idleMinutes };
    const backend = existing?.backend ?? caps?.android.backend ?? o.backend ?? "redroid";
    const b = caps?.android[backend];
    const out: DesktopOptions = { ...o, backend };
    if (out.googlePlay && b && !b.googlePlay) throw new DesktopError(`没有带 Google Play 的${backend === "redroid" ? " Redroid" : "模拟器"}镜像，需要先构建（见 README）`, "unavailable");
    if (backend === "emulator") out.armTranslation = true; // built into Google's x86_64 system images
    else if (out.armTranslation === undefined) out.armTranslation = !!b?.arm;
    else if (out.armTranslation && b && !b.arm) throw new DesktopError("Redroid 镜像没有带 ARM 转译，需要先用 --arm 构建（见 README）", "unavailable");
    return out;
  }

  async remove(id: string): Promise<void> {
    const r = this.row(id);
    await this.#closeBrowser(id);
    await this.#containers.remove(this.#containers.desktopName(id));
    if (r.kind === "android") await this.#containers.remove(this.#containers.androidName(id));
    this.setAgents(id, []);
    this.#db.prepare("DELETE FROM desktops WHERE id = ?").run(id);
    for (const cur of this.#current.values()) for (const f of ["screen", "web"] as const) if (cur[f] === id) delete cur[f];
    try {
      fs.rmSync(path.join(config.desktopsDir, id), { recursive: true, force: true });
    } catch (err) {
      console.error(`remove instance data ${id}`, err);
    }
    this.#events.publish("desktop", { id, removed: true });
  }

  async start(id: string): Promise<void> {
    const r = this.row(id);
    this.#starting.add(id);
    try {
      await this.#clearLocksIfDown(r);
      await this.#containers.ensureDesktop(this.spec(r));
      this.#touch(id);
      await this.#waitHealthy(id, r.kind === "android" ? 240 : 30);
    } finally {
      this.#starting.delete(id);
    }
    this.#events.publish("desktop", { id });
  }

  /** `keepFrame: false` skips saving the last screen (pointless, and slow, when the instance isn't answering). */
  async stop(id: string, opts: { keepFrame?: boolean } = {}): Promise<void> {
    const r = this.row(id);
    await this.#closeBrowser(id);
    if (opts.keepFrame !== false) await this.#keepFrame(id);
    await this.#containers.stop(this.#containers.desktopName(id));
    if (r.kind === "android") await this.#containers.stop(this.#containers.androidName(id), ANDROID_STOP_SECONDS);
    this.#events.publish("desktop", { id });
  }

  /** The emulator's virtual device directory, for emulator-backed Android instances. */
  #avdDir(r: DesktopRow): string | null {
    return r.kind === "android" && this.spec(r).backend === "emulator" ? path.join(config.desktopsDir, r.id, "avd", "constella.avd") : null;
  }

  /** Remove locks a killed emulator left behind, but only while it isn't running (live locks must stay). */
  async #clearLocksIfDown(r: DesktopRow): Promise<string[]> {
    const dir = this.#avdDir(r);
    if (!dir) return [];
    const device = await this.#containers.info(this.#containers.androidName(r.id)).catch(() => null);
    if (device && (device.state === "running" || device.state === "starting" || device.state === "paused")) return [];
    return clearStaleLocks(dir);
  }

  /** Being started or repaired right now. */
  busy(id: string): boolean {
    return this.#starting.has(id) || this.#repairs.has(id);
  }

  /**
   * What is wrong with an instance, if anything: container states and restart counts, the control service's own
   * answer, and the telling lines of the log. Cheap enough to run every minute.
   */
  async diagnose(id: string): Promise<InstanceHealth> {
    const r = this.row(id);
    const screenName = this.#containers.desktopName(id);
    const deviceName = r.kind === "android" ? this.#containers.androidName(id) : null;
    const screen = await this.#containers.info(screenName).catch(() => null);
    const device = deviceName ? await this.#containers.info(deviceName).catch(() => null) : null;
    const detail = [
      describeContainer(r.kind === "android" ? "画面和控制容器" : "实例容器", screen),
      ...(deviceName ? [describeContainer("安卓系统容器", device)] : []),
    ];
    const down = (c: ContainerInfo | null) => !c || c.state === "missing" || (c.state === "stopped" && !c.restarting);
    const paused = screen?.state === "paused";
    // Deliberately not running: it starts (or thaws) on first use.
    if (paused || (down(screen) && (!deviceName || down(device)))) {
      return { ok: true, state: paused ? "paused" : screen ? "stopped" : "missing", crashLoop: false, detail: detail.join("\n") };
    }
    let ready = false;
    let reason = "";
    try {
      const res = await fetch(`${this.controlUrl(id)}/health`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
      ready = res.ok;
      reason = body.reason || body.error || (res.ok ? "" : `HTTP ${res.status}`);
    } catch {
      reason = "控制服务没有响应";
    }
    detail.push(`控制服务：${ready ? "正常" : `不可用（${reason}）`}`);
    if (ready && !device?.restarting) return { ok: true, state: "running", crashLoop: false, detail: detail.join("\n") };

    const recent = (c: ContainerInfo | null, minutes: number) => !!c?.startedAt && Date.now() - Date.parse(c.startedAt) < minutes * 60_000;
    const looping = (c: ContainerInfo | null) => !!c && (c.restarting || (c.restartCount >= 3 && recent(c, 5)));
    const crashLoop = looping(device) || looping(screen);
    const logs = await this.#containers.logs(deviceName ?? screenName, 120).catch(() => "");
    const telling = [...new Set(logs.split("\n").map((l) => l.trim()).filter((l) => TELLING.test(l)))].slice(-6);
    if (telling.length) detail.push(`最近的错误日志：\n${telling.map((l) => `  ${l.slice(0, 300)}`).join("\n")}`);
    const fatal = telling.filter((l) => /FATAL/.test(l)).at(-1);
    const what = r.kind === "android" ? "安卓" : "实例";
    let problem: string;
    let state: InstanceHealth["state"] = "broken";
    if (crashLoop) {
      const c = looping(device) ? device! : screen!;
      problem = `${what}反复退出（Docker 已自动重启 ${c.restartCount} 次）${fatal ? `：${fatal.replace(/^FATAL\s*\|\s*/, "").slice(0, 160)}` : ""}`;
      if (fatal && /snapshot operation .* pending/i.test(fatal)) problem += "（上次被强制停止留下了锁文件）";
    } else if (deviceName && down(device)) {
      problem = "安卓系统没有在运行";
    } else if (device?.oomKilled || screen?.oomKilled) {
      problem = `${what}因内存不足被系统杀掉`;
    } else if (screen?.health === "starting" || (deviceName ? recent(device, 4) : recent(screen, 1)) || this.busy(id)) {
      problem = "正在启动";
      state = "starting";
    } else {
      problem = `${what}没有响应：${reason}`;
    }
    return { ok: false, state, problem, crashLoop, detail: detail.join("\n") };
  }

  /** Whether a repair of this instance is under way. */
  repairing(id: string): boolean {
    return this.#repairs.has(id);
  }

  /**
   * Bring a stuck instance back without losing data: stop it properly, clear what a hard kill left behind, start
   * and wait until it answers; if that doesn't do it, recreate its containers (the data lives in mounted
   * directories). One repair per instance at a time.
   */
  repair(id: string): Promise<RepairResult> {
    const running = this.#repairs.get(id);
    if (running) return running;
    const job = (async (): Promise<RepairResult> => {
      const r = this.row(id);
      const before = await this.diagnose(id);
      const steps: string[] = [];
      const attempt = async () => {
        try {
          await this.start(id);
          return true;
        } catch (err) {
          steps.push(`启动后没有恢复：${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      };
      await this.stop(id, { keepFrame: before.ok });
      steps.push(r.kind === "android" ? "停止了实例（给安卓留足时间正常关机）" : "停止了实例");
      const locks = await this.#clearLocksIfDown(r);
      if (locks.length) steps.push(`清理了上次强制停止留下的锁文件（${locks.join("、")}）`);
      let ok = await attempt();
      if (ok) steps.push("重新启动，确认已经可以正常使用");
      else {
        await this.#closeBrowser(id);
        await this.#containers.remove(this.#containers.desktopName(id));
        if (r.kind === "android") await this.#containers.remove(this.#containers.androidName(id));
        steps.push("删除并重建了实例的容器（数据保留）");
        ok = await attempt();
        if (ok) steps.push("重建后确认已经可以正常使用");
      }
      const after = await this.diagnose(id);
      audit(this.#db, "system", ok ? "instance.repair" : "instance.repair_failed", { id, name: r.name, problem: before.problem ?? null, steps });
      this.#events.publish("desktop", { id });
      return { ok: ok && after.ok, steps, before, after };
    })();
    this.#repairs.set(id, job);
    return job.finally(() => this.#repairs.delete(id));
  }

  /** Start an Android instance over from a clean system (its apps and data are lost). Only the owner decides this. */
  async reset(id: string, actor: string): Promise<RepairResult> {
    const r = this.row(id);
    if (r.kind !== "android") throw new DesktopError(`${this.describe(r)}不是安卓实例，不能清空重建`, "invalid");
    const before = await this.diagnose(id);
    await this.stop(id, { keepFrame: false });
    await this.#containers.remove(this.#containers.desktopName(id));
    await this.#containers.remove(this.#containers.androidName(id));
    fs.rmSync(path.join(config.desktopsDir, id, this.spec(r).backend === "emulator" ? "avd" : "data"), { recursive: true, force: true });
    const steps = ["删除了实例的容器和安卓数据（装过的 App 和登录状态都清空了）"];
    let ok = true;
    try {
      await this.start(id);
      steps.push("从全新的系统启动，确认已经可以正常使用");
    } catch (err) {
      ok = false;
      steps.push(`全新启动后仍没有恢复：${err instanceof Error ? err.message : String(err)}`);
    }
    const after = await this.diagnose(id);
    audit(this.#db, actor, "instance.reset", { id, name: r.name, steps });
    this.#events.publish("desktop", { id });
    return { ok: ok && after.ok, steps, before, after };
  }

  /** Freeze the instance's containers; memory stays allocated and it resumes in seconds. */
  async pause(id: string): Promise<void> {
    const r = this.row(id);
    if ((await this.state(id)) !== "running") return;
    await this.#keepFrame(id);
    await this.#containers.pause(this.#containers.desktopName(id));
    if (r.kind === "android") await this.#containers.pause(this.#containers.androidName(id));
    this.#events.publish("desktop", { id });
  }

  /** Thaw a paused instance (no-op otherwise). */
  async resume(id: string): Promise<void> {
    const r = this.row(id);
    if (r.kind === "android") await this.#containers.unpause(this.#containers.androidName(id));
    await this.#containers.unpause(this.#containers.desktopName(id));
    this.#touch(id);
    this.#events.publish("desktop", { id });
  }

  /** Stop and start again, picking up changed options; the way out when an instance is stuck. */
  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  /** Make sure someone opening the viewer finds a live screen: thaw if paused. */
  async wake(id: string): Promise<void> {
    if ((await this.state(id)) === "paused") await this.resume(id);
  }

  /** Point a run's desktop_* (and browser_*, when it has a browser) calls at one of the agent's instances. */
  use(agentId: string, runId: string, id: string): DesktopRow {
    const r = this.boundTo(agentId).find((x) => x.id === id);
    if (!r) throw new DesktopError("这个实例没有绑定给你，用 instance_list 查看可用的实例", "not_found");
    const cur = this.#current.get(runId) ?? {};
    cur.screen = id;
    if (WEB_KINDS.includes(r.kind)) cur.web = id;
    this.#current.set(runId, cur);
    return r;
  }

  /** The instance a run is currently on for a tool family, if any. */
  current(runId: string, family: ToolFamily = "screen"): string | undefined {
    return this.#current.get(runId)?.[family];
  }

  /**
   * The instance an agent's tool call should act on, leased to its run: the run's current one, then one it already
   * holds, then the first free instance it is bound to (bare browsers first for browser_*).
   */
  async acquire(agentId: string, runId: string, family: ToolFamily = "screen"): Promise<string> {
    const fits = (r: DesktopRow) => family === "screen" || WEB_KINDS.includes(r.kind);
    const bound = this.boundTo(agentId).filter(fits);
    const what = family === "web" ? "带浏览器的实例（浏览器或 Linux 桌面）" : "实例";
    if (!bound.length) throw new DesktopError(`你没有绑定可用的${what}。可以用 instance_create 新建一个（可能需要主人审批），或请主人在 agent 设置里绑定。`, "not_found");
    const cur = this.#current.get(runId) ?? {};
    const leaseOf = (r: DesktopRow) => JSON.parse(r.lease) as DesktopLease;
    const mine = (r: DesktopRow) => {
      const l = leaseOf(r);
      return (l.holder === "agent" && l.runId === runId) || (l.holder === "human" && this.#displaced.get(r.id)?.runId === runId);
    };
    const free = bound.filter((r) => leaseOf(r).holder === "none");
    const pick =
      bound.find((r) => r.id === cur[family]) ??
      (family === "web" ? bound.find((r) => r.id === cur.screen) : undefined) ??
      bound.find(mine) ??
      (family === "web" ? free.find((r) => r.kind === "browser") : undefined) ??
      free[0];
    if (!pick) throw new DesktopError(`你绑定的${what}都在被其他任务或主人使用，请稍后再试，或用 instance_create 新建一个`, "busy");
    const l = leaseOf(pick);
    if (l.holder === "human") await this.waitForHandback(pick.id);
    else if (l.holder === "agent" && l.runId !== runId) throw new DesktopError(`${this.describe(pick)}正被另一个任务使用，请稍后再试或用 instance_use 换一个`, "busy");
    if (this.lease(pick.id).holder === "none") this.#setLease(pick.id, { holder: "agent", agentId, runId, since: nowIso() });
    cur[family] = pick.id;
    this.#current.set(runId, cur);
    return this.#ready(pick.id);
  }

  /** Release every lease a finished run holds. */
  releaseRun(runId: string): void {
    this.#current.delete(runId);
    for (const r of this.rows()) {
      const l = JSON.parse(r.lease) as DesktopLease;
      if (l.holder === "agent" && l.runId === runId) this.#setLease(r.id, { holder: "none" });
      if (this.#displaced.get(r.id)?.runId === runId) this.#displaced.delete(r.id);
      if (this.#help.get(r.id)?.runId === runId) this.#help.delete(r.id);
    }
  }

  takeover(id: string, actor: string): void {
    const l = this.lease(id);
    if (l.holder === "human") return;
    const help = this.#help.get(id);
    if (l.holder === "agent") {
      this.#displaced.set(id, l);
      this.#runs.transition(l.runId, "paused_by_user");
      if (!help) this.#runs.appendFor(l.runId, { type: "desktop.action", runId: l.runId, desktopId: id, action: "用户接管了实例" });
    }
    if (help) this.#helpEvent(id, help, "taken");
    this.#setLease(id, { holder: "human", since: nowIso() });
    audit(this.#db, actor, "desktop.takeover", { id });
  }

  handback(id: string, note: string, actor: string): void {
    const l = this.lease(id);
    if (l.holder !== "human") return;
    const prev = this.#displaced.get(id);
    this.#displaced.delete(id);
    const help = this.#help.get(id);
    this.#help.delete(id);
    if (help) this.#helpEvent(id, help, "returned", { note: note || undefined });
    const run = prev ? this.#runs.get(prev.runId) : undefined;
    if (prev && run && !["done", "failed", "cancelled"].includes(run.status)) {
      this.#setLease(id, { ...prev, since: nowIso() });
      this.#runs.transition(prev.runId, "running");
      if (!help) this.#runs.appendFor(prev.runId, { type: "desktop.action", runId: prev.runId, desktopId: id, action: `用户交还了实例${note ? `：${note}` : ""}` });
    } else {
      this.#setLease(id, { holder: "none" });
    }
    for (const resolve of this.#handbackWaiters.get(id) ?? []) resolve(note);
    this.#handbackWaiters.delete(id);
    audit(this.#db, actor, "desktop.handback", { id, note });
  }

  waitForHandback(id: string, timeoutMs = HELP_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待用户交还实例超时")), timeoutMs);
      const list = this.#handbackWaiters.get(id) ?? [];
      list.push((note) => {
        clearTimeout(timer);
        resolve(note);
      });
      this.#handbackWaiters.set(id, list);
    });
  }

  /**
   * Agent asks the user to take over (login, captcha, payment): a push notification plus a card in the run's chat
   * the owner can take over from. Resolves with the user's note on hand-back.
   */
  async requestHelp(id: string, runId: string, agentName: string, reason: string, notify: (title: string, body: string, url: string) => void): Promise<string> {
    const help = { helpId: newId("help"), runId };
    this.#help.set(id, help);
    this.#helpEvent(id, help, "requested", { reason });
    notify(`${agentName} 需要你帮忙操作实例`, reason, `/instances/${id}`);
    this.#events.publish("desktop.help", { id, reason });
    try {
      return await this.waitForHandback(id);
    } catch (err) {
      if (this.#help.get(id) === help) {
        this.#help.delete(id);
        this.#helpEvent(id, help, "expired");
      }
      throw err;
    }
  }

  #helpEvent(id: string, help: { helpId: string; runId: string }, state: "requested" | "taken" | "returned" | "expired", extra: { reason?: string; note?: string } = {}): void {
    this.#runs.appendFor(help.runId, { type: "desktop.help", runId: help.runId, helpId: help.helpId, desktopId: id, state, ...extra });
  }

  controlUrl(id: string): string {
    return `http://${this.#containers.desktopName(id)}:8000`;
  }

  async action(id: string, a: DesktopAction): Promise<void> {
    await this.#post(id, "/action", a);
    this.#touch(id);
  }

  async screenshot(id: string, opts: { width?: number; quality?: number } = {}): Promise<{ data: Buffer; screen: string }> {
    const q = new URLSearchParams();
    if (opts.width) q.set("width", String(opts.width));
    if (opts.quality) q.set("quality", String(opts.quality));
    const res = await fetch(`${this.controlUrl(id)}/screenshot?${q}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`截图失败：${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), screen: res.headers.get("x-screen-size") ?? "" };
  }

  /** Thumbnail for lists: live when running, otherwise the frame kept when it was last paused or stopped. */
  async thumbnail(id: string, width: number): Promise<Buffer | null> {
    if ((await this.state(id)) === "running") return (await this.screenshot(id, { width, quality: 60 })).data;
    try {
      return fs.readFileSync(this.#framePath(id));
    } catch {
      return null;
    }
  }

  async clipboard(id: string, text?: string): Promise<string> {
    if (text !== undefined) {
      await this.#post(id, "/clipboard", { text });
      return text;
    }
    const res = await fetch(`${this.controlUrl(id)}/clipboard`, { signal: AbortSignal.timeout(10_000) });
    return ((await res.json()) as { text?: string }).text ?? "";
  }

  /** Start a program (Linux desktop) or app by package name (Android). */
  async launch(id: string, app: string): Promise<void> {
    await this.#post(id, "/launch", { app });
    this.#touch(id);
  }

  /** Android: the on-screen UI as a compact element list (text, description, id, clickable, center). */
  async androidUi(id: string): Promise<string> {
    this.#requireKind(id, "android");
    const res = await fetch(`${this.controlUrl(id)}/ui`, { signal: AbortSignal.timeout(30_000) });
    const out = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(out.error ?? `ui ${res.status}`);
    this.#touch(id);
    return out.text ?? "";
  }

  /** Android: installed third-party apps. */
  async androidApps(id: string): Promise<{ package: string; label?: string }[]> {
    this.#requireKind(id, "android");
    const res = await fetch(`${this.controlUrl(id)}/apps`, { signal: AbortSignal.timeout(30_000) });
    const out = (await res.json().catch(() => ({}))) as { apps?: { package: string; label?: string }[]; error?: string };
    if (!res.ok) throw new Error(out.error ?? `apps ${res.status}`);
    return out.apps ?? [];
  }

  /** Android: install an APK (bytes are streamed to the bridge, which runs `adb install`). */
  async androidInstall(id: string, apk: Buffer): Promise<string> {
    this.#requireKind(id, "android");
    const res = await fetch(`${this.controlUrl(id)}/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.android.package-archive" },
      body: new Uint8Array(apk),
      signal: AbortSignal.timeout(600_000),
    });
    const out = (await res.json().catch(() => ({}))) as { package?: string; output?: string; error?: string };
    if (!res.ok) throw new Error(out.error ?? `install ${res.status}`);
    this.#touch(id);
    return out.package ?? out.output ?? "";
  }

  /** Android with Google Play: the GSF id to register the (uncertified) device with Google. */
  async androidGsfId(id: string): Promise<string | null> {
    this.#requireKind(id, "android");
    const res = await fetch(`${this.controlUrl(id)}/gsf-id`, { signal: AbortSignal.timeout(20_000) });
    return ((await res.json().catch(() => ({}))) as { id?: string | null }).id ?? null;
  }

  #requireKind(id: string, kind: DesktopKind): void {
    const r = this.row(id);
    if (r.kind !== kind) throw new DesktopError(`${this.describe(r)}不是${KIND_LABEL[kind]}实例`, "invalid");
  }

  /** Playwright page on the instance's visible Chromium (started on demand). */
  async page(id: string): Promise<Page> {
    const r = this.row(id);
    if (!WEB_KINDS.includes(r.kind)) throw new DesktopError(`${this.describe(r)}没有可用 browser_* 操作的浏览器；安卓实例用 android_ui 和 desktop_*`, "invalid");
    let browser = this.#browsers.get(id);
    if (!browser?.isConnected()) {
      await this.#post(id, "/browser/ensure", {});
      // Chromium only serves DevTools when the Host header is an IP or localhost, so address it by IP.
      const { address, family } = await dns.lookup(this.#containers.desktopName(id));
      const host = `${family === 6 ? `[${address}]` : address}:9223`;
      const res = await fetch(`http://${host}/json/version`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`浏览器调试接口不可用：${(await res.text()).slice(0, 120)}`);
      const version = (await res.json()) as { webSocketDebuggerUrl: string };
      const wsUrl = version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${host}`);
      browser = await chromium.connectOverCDP(wsUrl, { timeout: 20_000 });
      browser.on("disconnected", () => this.#browsers.delete(id));
      this.#browsers.set(id, browser);
    }
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const pages = context.pages().filter((p) => !p.url().startsWith("devtools://"));
    const page = pages.at(-1) ?? (await context.newPage());
    this.#touch(id);
    return page;
  }

  async pages(id: string): Promise<Page[]> {
    await this.page(id);
    const browser = this.#browsers.get(id)!;
    return browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith("devtools://"));
  }

  /**
   * WebSocket ↔ VNC bridge. Viewer input (keys, pointer, clipboard) only passes while the
   * viewer holds the lease (`canInput`), enforced by parsing client RFB messages.
   */
  bridgeVnc(ws: WebSocket, id: string, canInput: () => boolean): void {
    const sock = net.connect(5900, this.#containers.desktopName(id));
    const filter = new RfbClientFilter(canInput);
    this.#viewers.set(id, (this.#viewers.get(id) ?? 0) + 1);
    let open = true;
    const closed = () => {
      if (!open) return;
      open = false;
      const n = (this.#viewers.get(id) ?? 1) - 1;
      if (n > 0) this.#viewers.set(id, n);
      else this.#viewers.delete(id);
      // Idle time counts from when the last viewer left.
      try {
        this.#touch(id);
      } catch {}
    };
    ws.binaryType = "nodebuffer";
    sock.on("data", (d) => ws.readyState === ws.OPEN && ws.send(d));
    sock.on("close", () => ws.close());
    sock.on("error", () => ws.close());
    ws.on("message", (d: Buffer) => {
      const out = filter.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
      if (out === null) {
        ws.close(1008, "unsupported RFB message");
        sock.destroy();
        return;
      }
      if (out.length) sock.write(out);
    });
    ws.on("close", () => {
      sock.destroy();
      closed();
    });
    this.#touch(id);
  }

  startReaper(): void {
    this.#timer = setInterval(() => void this.reap(), 60_000);
    this.#timer.unref();
  }

  /** Pause or stop instances nobody holds, watches or has used for their idle time. */
  async reap(now = Date.now()): Promise<void> {
    for (const r of this.rows()) {
      const { action, minutes } = this.idle(r);
      if (action === "none" || minutes <= 0) continue;
      if ((JSON.parse(r.lease) as DesktopLease).holder !== "none" || this.#viewers.get(r.id)) continue;
      if (Date.parse(r.last_used_at) > now - minutes * 60_000) continue;
      const state = await this.state(r.id);
      if (action === "pause" && state === "running") await this.pause(r.id).catch((err) => console.error(`pause ${r.id}`, err));
      if (action === "stop" && (state === "running" || state === "paused")) await this.stop(r.id).catch((err) => console.error(`stop ${r.id}`, err));
    }
  }

  async #ready(id: string): Promise<string> {
    const state = await this.state(id);
    if (state === "paused") {
      await this.resume(id);
      await this.#waitHealthy(id, 30);
    } else if (state !== "running") await this.start(id);
    return id;
  }

  async #healthy(id: string, timeoutMs = 2000): Promise<boolean> {
    try {
      return (await fetch(`${this.controlUrl(id)}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
    } catch {
      return false;
    }
  }

  async #waitHealthy(id: string, seconds: number): Promise<void> {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      if (await this.#healthy(id)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    const h = await this.diagnose(id).catch(() => null);
    throw new DesktopError(`${this.describe(this.row(id))}启动超时${h?.problem && h.problem !== "正在启动" ? `：${h.problem}` : ""}`, "unavailable");
  }

  /** Keep the current screen as the thumbnail shown while paused or stopped. */
  async #keepFrame(id: string): Promise<void> {
    try {
      if ((await this.state(id)) !== "running") return;
      const shot = await this.screenshot(id, { width: 640, quality: 60 });
      fs.mkdirSync(path.dirname(this.#framePath(id)), { recursive: true });
      fs.writeFileSync(this.#framePath(id), shot.data);
    } catch {}
  }

  #framePath(id: string): string {
    return path.join(config.desktopsDir, id, "last-frame.jpg");
  }

  async #post(id: string, p: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.controlUrl(id)}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(130_000),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(out.error ?? `desktop ${p} ${res.status}`);
    return out;
  }

  #setLease(id: string, lease: DesktopLease): void {
    this.#db.prepare("UPDATE desktops SET lease = ?, last_used_at = ? WHERE id = ?").run(JSON.stringify(lease), nowIso(), id);
    this.#events.publish("desktop", { id, lease });
  }

  #touch(id: string): void {
    this.#db.prepare("UPDATE desktops SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }

  async #closeBrowser(id: string): Promise<void> {
    const b = this.#browsers.get(id);
    this.#browsers.delete(id);
    await b?.close().catch(() => {});
  }
}

const CONTAINER_STATE: Record<string, string> = { running: "运行中", paused: "已暂停", stopped: "已停止", missing: "不存在", starting: "启动中", error: "异常" };

function describeContainer(label: string, c: ContainerInfo | null): string {
  if (!c) return `${label}：不存在`;
  const parts = [c.restarting ? "正在被 Docker 自动重启" : (CONTAINER_STATE[c.state] ?? c.state)];
  if (c.restartCount) parts.push(`Docker 自动重启过 ${c.restartCount} 次`);
  if (c.startedAt) parts.push(`最近一次启动 ${c.startedAt}`);
  if (c.oomKilled) parts.push("上次因内存不足被杀");
  if (c.health) parts.push(`健康检查 ${c.health}`);
  if (c.state === "stopped" && c.exitCode !== null) parts.push(`退出码 ${c.exitCode}`);
  return `${label}：${parts.join("，")}`;
}

/**
 * Incremental parser for client→server RFB 3.8 messages (after a None-security handshake).
 * Drops input messages while `canInput()` is false. Returns null on an unknown message type.
 */
export class RfbClientFilter {
  #buf = Buffer.alloc(0);
  #stage: "version" | "security" | "init" | "normal" = "version";
  #canInput: () => boolean;

  constructor(canInput: () => boolean) {
    this.#canInput = canInput;
  }

  push(chunk: Buffer): Buffer | null {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const len = this.#nextLength();
      if (len === null) return null;
      if (len === 0 || this.#buf.length < len) break;
      const msg = this.#buf.subarray(0, len);
      this.#buf = this.#buf.subarray(len);
      if (this.#stage === "version") this.#stage = "security";
      else if (this.#stage === "security") this.#stage = "init";
      else if (this.#stage === "init") this.#stage = "normal";
      else if (isInput(msg[0]!) && !this.#canInput()) continue;
      out.push(Buffer.from(msg));
    }
    return Buffer.concat(out);
  }

  /** Length of the next complete message, 0 if more bytes are needed, null if unknown. */
  #nextLength(): number | null {
    const b = this.#buf;
    if (this.#stage === "version") return b.length >= 12 ? 12 : 0;
    if (this.#stage === "security" || this.#stage === "init") return b.length >= 1 ? 1 : 0;
    if (b.length < 1) return 0;
    const need = (n: number) => (b.length >= n ? n : 0);
    switch (b[0]) {
      case 0: // SetPixelFormat
        return need(20);
      case 2: // SetEncodings
        return b.length >= 4 ? need(4 + 4 * b.readUInt16BE(2)) : 0;
      case 3: // FramebufferUpdateRequest
        return need(10);
      case 4: // KeyEvent
        return need(8);
      case 5: // PointerEvent
        return need(6);
      case 6: // ClientCutText (negative length = extended clipboard)
        return b.length >= 8 ? need(8 + Math.abs(b.readInt32BE(4))) : 0;
      case 150: // EnableContinuousUpdates
        return need(10);
      case 248: // ClientFence
        return b.length >= 9 ? need(9 + b[8]!) : 0;
      case 251: // SetDesktopSize
        return b.length >= 8 ? need(8 + 16 * b[6]!) : 0;
      case 255: // QEMU extended key event
        return need(12);
      default:
        return null;
    }
  }
}

function isInput(type: number): boolean {
  return type === 4 || type === 5 || type === 6 || type === 255 || type === 251;
}
