import net from "node:net";
import type { DesktopLease, DesktopPolicy } from "@constella/protocol";
import { chromium, type Browser, type Page } from "playwright-core";
import type { WebSocket } from "ws";
import { config, newId, nowIso } from "./config.ts";
import { audit, type Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import type { Containers } from "./containers.ts";
import type { RunManager } from "./runs.ts";

export interface DesktopRow {
  id: string;
  name: string;
  lease: string;
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

const MAX_ON_DEMAND = 4;
const HELP_TIMEOUT_MS = 15 * 60_000;

/** Desktop pool: container lifecycle, single-holder leases, takeover/hand-back, control and browser access. */
export class Desktops {
  #db: Db;
  #events: EventStore;
  #containers: Containers;
  #runs: RunManager;
  #browsers = new Map<string, Browser>();
  /** Resolvers waiting for the human to hand a desktop back. */
  #handbackWaiters = new Map<string, ((note: string) => void)[]>();
  /** Agent lease displaced by a takeover, restored on hand-back. */
  #displaced = new Map<string, Extract<DesktopLease, { holder: "agent" }>>();
  /** Open requests for the owner to take over, by desktop; their progress shows up in the run's chat. */
  #help = new Map<string, { helpId: string; runId: string }>();
  #timer: NodeJS.Timeout | null = null;
  #idleMinutes: () => number;

  constructor(deps: { db: Db; events: EventStore; containers: Containers; runs: RunManager; idleMinutes?: () => number }) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#containers = deps.containers;
    this.#runs = deps.runs;
    this.#idleMinutes = deps.idleMinutes ?? (() => config.desktopIdleMinutes);
  }

  rows(): DesktopRow[] {
    return this.#db.prepare("SELECT * FROM desktops ORDER BY created_at").all() as unknown as DesktopRow[];
  }

  row(id: string): DesktopRow {
    const r = this.#db.prepare("SELECT * FROM desktops WHERE id = ?").get(id) as DesktopRow | undefined;
    if (!r) throw new Error("desktop not found");
    return r;
  }

  lease(id: string): DesktopLease {
    return JSON.parse(this.row(id).lease) as DesktopLease;
  }

  async list(): Promise<(DesktopRow & { state: string; leaseInfo: DesktopLease })[]> {
    return Promise.all(
      this.rows().map(async (r) => ({
        ...r,
        state: await this.#containers.state(this.#containers.desktopName(r.id)).catch(() => "error"),
        leaseInfo: JSON.parse(r.lease),
      })),
    );
  }

  create(name: string, pinnedAgentId: string | null = null): DesktopRow {
    const row: DesktopRow = {
      id: newId("dt").toLowerCase().replace(/_/g, "-"),
      name,
      lease: JSON.stringify({ holder: "none" }),
      pinned_agent_id: pinnedAgentId,
      created_at: nowIso(),
      last_used_at: nowIso(),
    };
    this.#db
      .prepare("INSERT INTO desktops (id, name, lease, pinned_agent_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.lease, row.pinned_agent_id, row.created_at, row.last_used_at);
    this.#events.publish("desktop", { id: row.id });
    return row;
  }

  rename(id: string, name: string): void {
    this.#db.prepare("UPDATE desktops SET name = ? WHERE id = ?").run(name, id);
    this.#events.publish("desktop", { id });
  }

  async remove(id: string): Promise<void> {
    await this.#closeBrowser(id);
    await this.#containers.remove(this.#containers.desktopName(id));
    this.#db.prepare("DELETE FROM desktops WHERE id = ?").run(id);
    this.#events.publish("desktop", { id, removed: true });
  }

  async start(id: string): Promise<void> {
    this.row(id);
    await this.#containers.ensureDesktop({ desktopId: id });
    this.#touch(id);
    await this.#waitHealthy(id);
    this.#events.publish("desktop", { id });
  }

  async stop(id: string): Promise<void> {
    await this.#closeBrowser(id);
    await this.#containers.stop(this.#containers.desktopName(id));
    this.#events.publish("desktop", { id });
  }

  /** The desktop an agent's tool call should act on, acquiring a lease per the agent's policy. */
  async acquire(agentId: string, runId: string): Promise<string> {
    const policyRow = this.#db.prepare("SELECT desktop_policy FROM agents WHERE id = ?").get(agentId) as { desktop_policy: string } | undefined;
    const policy = JSON.parse(policyRow?.desktop_policy ?? '{"mode":"none"}') as DesktopPolicy;
    // Already holding one for this run?
    for (const r of this.rows()) {
      const l = JSON.parse(r.lease) as DesktopLease;
      if (l.holder === "agent" && l.runId === runId) return this.#ready(r.id);
      if (l.holder === "human" && this.#displaced.get(r.id)?.runId === runId) {
        await this.waitForHandback(r.id);
        return this.#ready(r.id);
      }
    }
    if (policy.mode === "none") throw new Error("这个 agent 没有分配桌面。请在 App 的 agent 设置里把桌面策略改为“固定”或“按需借用”。");
    let id: string;
    if (policy.mode === "fixed") {
      id = policy.desktopId;
      const l = this.lease(id);
      if (l.holder === "human") await this.waitForHandback(id);
      else if (l.holder === "agent" && l.runId !== runId) throw new Error("桌面正被同一 agent 的另一个任务使用，请稍后再试");
    } else {
      const free = this.rows().find((r) => (JSON.parse(r.lease) as DesktopLease).holder === "none" && (!r.pinned_agent_id || r.pinned_agent_id === agentId));
      if (free) id = free.id;
      else {
        if (this.rows().length >= MAX_ON_DEMAND) throw new Error("桌面都在使用中，请稍后再试");
        id = this.create(`临时桌面 ${this.rows().length + 1}`).id;
      }
    }
    this.#setLease(id, { holder: "agent", agentId, runId, since: nowIso() });
    return this.#ready(id);
  }

  /** Release every lease a finished run holds. */
  releaseRun(runId: string): void {
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
      if (!help) this.#runs.appendFor(l.runId, { type: "desktop.action", runId: l.runId, desktopId: id, action: "用户接管了桌面" });
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
      if (!help) this.#runs.appendFor(prev.runId, { type: "desktop.action", runId: prev.runId, desktopId: id, action: `用户交还了桌面${note ? `：${note}` : ""}` });
    } else {
      this.#setLease(id, { holder: "none" });
    }
    for (const resolve of this.#handbackWaiters.get(id) ?? []) resolve(note);
    this.#handbackWaiters.delete(id);
    audit(this.#db, actor, "desktop.handback", { id, note });
  }

  waitForHandback(id: string, timeoutMs = HELP_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待用户交还桌面超时")), timeoutMs);
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
    notify(`${agentName} 需要你帮忙操作桌面`, reason, `/desktops/${id}`);
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

  async clipboard(id: string, text?: string): Promise<string> {
    if (text !== undefined) {
      await this.#post(id, "/clipboard", { text });
      return text;
    }
    const res = await fetch(`${this.controlUrl(id)}/clipboard`, { signal: AbortSignal.timeout(10_000) });
    return ((await res.json()) as { text?: string }).text ?? "";
  }

  async launch(id: string, app: string): Promise<void> {
    await this.#post(id, "/launch", { app });
  }

  /** Playwright page on the desktop's visible Chromium (started on demand). */
  async page(id: string): Promise<Page> {
    let browser = this.#browsers.get(id);
    if (!browser?.isConnected()) {
      await this.#post(id, "/browser/ensure", {});
      const host = this.#containers.desktopName(id);
      const version = (await (await fetch(`http://${host}:9223/json/version`)).json()) as { webSocketDebuggerUrl: string };
      const wsUrl = version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${host}:9223`);
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
    ws.on("close", () => sock.destroy());
    this.#touch(id);
  }

  startReaper(): void {
    this.#timer = setInterval(() => void this.#reap(), 60_000);
    this.#timer.unref();
  }

  async #reap(): Promise<void> {
    const idle = this.#idleMinutes();
    if (idle <= 0) return;
    const cutoff = Date.now() - idle * 60_000;
    for (const r of this.rows()) {
      const l = JSON.parse(r.lease) as DesktopLease;
      if (l.holder !== "none" || Date.parse(r.last_used_at) > cutoff) continue;
      const state = await this.#containers.state(this.#containers.desktopName(r.id)).catch(() => "error");
      if (state === "running") await this.stop(r.id).catch(() => {});
    }
  }

  async #ready(id: string): Promise<string> {
    const state = await this.#containers.state(this.#containers.desktopName(id));
    if (state !== "running") await this.start(id);
    return id;
  }

  async #waitHealthy(id: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${this.controlUrl(id)}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("桌面启动超时");
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
