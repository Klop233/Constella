import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Docker from "dockerode";
import { config } from "./config.ts";
import type { Db } from "./db.ts";
import { kvGet, kvSet } from "./db.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * Optional online Office editor: an OnlyOffice Document Server container that the hub installs, starts, stops
 * and removes on request (Settings → System). The hub serves it on its own origin under /office-ds/, and
 * artifacts of Office types open in it; saves come back through a signed callback as new versions.
 */

export const OFFICE_CONTAINER = "constella-office";
export const OFFICE_PREFIX = "/office-ds";
const ROLE = "dev.constella.role";
const MEMORY_CHOICES = [2048, 3072, 4096, 6144, 8192];
const IDLE_CHOICES = [0, 5, 15, 30, 60, 120];

/** File types the editor opens (legacy binary formats included; no separate conversion step is needed). */
export const OFFICE_EXT = /\.(docx?|dotx?|odt|rtf|xlsx?|xltx?|ods|csv|pptx?|potx?|odp)$/i;
export function officeDocType(filename: string): "word" | "cell" | "slide" | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (!ext || ext === "csv") return null;
  if (["doc", "docx", "dot", "dotx", "odt", "rtf"].includes(ext)) return "word";
  if (["xls", "xlsx", "xlt", "xltx", "ods"].includes(ext)) return "cell";
  if (["ppt", "pptx", "pot", "potx", "odp"].includes(ext)) return "slide";
  return null;
}

export interface OfficeStatus {
  enabled: boolean;
  image: string;
  imagePresent: boolean;
  imageSizeMb: number | null;
  state: "off" | "stopped" | "starting" | "running" | "error";
  pulling: { active: boolean; percent: number; error: string | null };
  memoryMb: number;
  usedMb: number | null;
  idleMinutes: number;
  memoryChoices: number[];
  idleChoices: number[];
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class OfficeService {
  #db: Db;
  #secrets: SecretStore;
  #docker: Docker;
  #lastUsed = 0;
  #starting: Promise<void> | null = null;
  #pull: { active: boolean; percent: number; error: string | null } = { active: false, percent: 0, error: null };
  #timer: NodeJS.Timeout | undefined;

  constructor(opts: { db: Db; secrets: SecretStore; docker: Docker }) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#docker = opts.docker;
  }

  // ── settings ─────────────────────────────────────────────
  enabled(): boolean {
    return kvGet(this.#db, "settings.office.enabled") === "true";
  }
  image(): string {
    return config.officeImage;
  }
  memoryMb(): number {
    const v = Number(kvGet(this.#db, "settings.office.memoryMb"));
    return MEMORY_CHOICES.includes(v) ? v : 3072;
  }
  idleMinutes(): number {
    const raw = kvGet(this.#db, "settings.office.idleMinutes");
    const v = Number(raw);
    return raw !== undefined && IDLE_CHOICES.includes(v) ? v : 30;
  }
  configure(p: { enabled?: boolean; memoryMb?: number; idleMinutes?: number }): void {
    if (p.memoryMb !== undefined) {
      if (!MEMORY_CHOICES.includes(p.memoryMb)) throw new Error("内存上限只能是 2 / 3 / 4 / 6 / 8 GB");
      kvSet(this.#db, "settings.office.memoryMb", String(p.memoryMb));
    }
    if (p.idleMinutes !== undefined) {
      if (!IDLE_CHOICES.includes(p.idleMinutes)) throw new Error("闲置时间不在可选范围内");
      kvSet(this.#db, "settings.office.idleMinutes", String(p.idleMinutes));
    }
    if (p.enabled !== undefined) kvSet(this.#db, "settings.office.enabled", String(p.enabled));
  }

  // ── secrets and signed links ─────────────────────────────
  secret(): string {
    let s = this.#secrets.get("office", "jwt");
    if (!s) {
      s = randomBytes(32).toString("base64url");
      this.#secrets.set("office", "jwt", s);
    }
    return s;
  }
  /** A link token the Document Server uses to fetch a file / post a save; expires after a day. */
  sign(data: { a: string; v: number }, ttlMs = 24 * 3600_000): string {
    const body = b64(JSON.stringify({ ...data, exp: Date.now() + ttlMs }));
    return `${body}.${createHmac("sha256", this.secret()).update(body).digest("base64url")}`;
  }
  verify(token: string): { a: string; v: number } | null {
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", this.secret()).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const d = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return d.exp > Date.now() && typeof d.a === "string" && typeof d.v === "number" ? { a: d.a, v: d.v } : null;
    } catch {
      return null;
    }
  }
  /** HS256 JWT in the form the Document Server expects for its config and callbacks. */
  jwtSign(payload: object): string {
    const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64(JSON.stringify(payload));
    return `${head}.${body}.${createHmac("sha256", this.secret()).update(`${head}.${body}`).digest("base64url")}`;
  }
  jwtVerify(token: string): Record<string, any> | null {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const want = createHmac("sha256", this.secret()).update(`${h}.${p}`).digest();
    const got = Buffer.from(s, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      return JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  }

  // ── status ───────────────────────────────────────────────
  async #image(): Promise<{ present: boolean; sizeMb: number | null }> {
    try {
      const info = await this.#docker.getImage(this.image()).inspect();
      return { present: true, sizeMb: Math.round(info.Size / 1024 / 1024) };
    } catch {
      return { present: false, sizeMb: null };
    }
  }

  async status(): Promise<OfficeStatus> {
    const img = await this.#image();
    let state: OfficeStatus["state"] = "off";
    let usedMb: number | null = null;
    try {
      const info = await this.#docker.getContainer(OFFICE_CONTAINER).inspect();
      if (info.State.Running) {
        state = info.State.Health?.Status === "starting" ? "starting" : "running";
        const s: any = await this.#docker.getContainer(OFFICE_CONTAINER).stats({ stream: false }).catch(() => null);
        if (s?.memory_stats?.usage) usedMb = Math.round((s.memory_stats.usage - (s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0)) / 1024 / 1024);
      } else state = info.State.Status === "dead" ? "error" : "stopped";
    } catch {
      state = "off";
    }
    if (this.#starting && state !== "running") state = "starting";
    return {
      enabled: this.enabled(),
      image: this.image(),
      imagePresent: img.present,
      imageSizeMb: img.sizeMb,
      state: state === "off" && img.present && this.enabled() ? "stopped" : state,
      pulling: { ...this.#pull },
      memoryMb: this.memoryMb(),
      usedMb,
      idleMinutes: this.idleMinutes(),
      memoryChoices: MEMORY_CHOICES,
      idleChoices: IDLE_CHOICES,
    };
  }

  // ── lifecycle ────────────────────────────────────────────
  /** Download the image in the background; progress is in status().pulling. */
  install(): void {
    if (this.#pull.active) return;
    this.#pull = { active: true, percent: 0, error: null };
    void (async () => {
      try {
        const stream = await this.#docker.pull(this.image());
        const layers = new Map<string, { cur: number; total: number }>();
        await new Promise<void>((resolve, reject) => {
          this.#docker.modem.followProgress(
            stream,
            (err: Error | null) => (err ? reject(err) : resolve()),
            (ev: any) => {
              if (ev.id && ev.progressDetail?.total) {
                layers.set(ev.id, { cur: ev.progressDetail.current ?? 0, total: ev.progressDetail.total });
                let cur = 0;
                let total = 0;
                for (const l of layers.values()) {
                  cur += l.cur;
                  total += l.total;
                }
                this.#pull.percent = total ? Math.min(99, Math.round((cur / total) * 100)) : 0;
              }
            },
          );
        });
        this.#pull = { active: false, percent: 100, error: null };
      } catch (err) {
        this.#pull = { active: false, percent: 0, error: err instanceof Error ? err.message : String(err) };
      }
    })();
  }

  /** The container is created (with the current limits) and running, and the service answers. */
  ensureRunning(): Promise<void> {
    this.touch();
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    if (!this.enabled()) throw new Error("在线 Office 编辑器没有启用");
    if (!(await this.#image()).present) throw new Error("编辑器镜像还没有下载，请先在设置里启用并等下载完成");
    const memory = this.memoryMb() * 1024 * 1024;
    let info: Docker.ContainerInspectInfo | null = null;
    try {
      info = await this.#docker.getContainer(OFFICE_CONTAINER).inspect();
    } catch {
      info = null;
    }
    // Limits or secret changed: recreate (nothing in the container needs keeping).
    if (info && (info.HostConfig.Memory !== memory || !info.Config.Env?.includes(`JWT_SECRET=${this.secret()}`))) {
      await this.#docker.getContainer(OFFICE_CONTAINER).remove({ force: true });
      info = null;
    }
    if (!info) {
      await this.#docker.createContainer({
        name: OFFICE_CONTAINER,
        Image: this.image(),
        Env: [
          "JWT_ENABLED=true",
          `JWT_SECRET=${this.secret()}`,
          "JWT_HEADER=Authorization",
          // The hub is on a private network; the Document Server must be allowed to call it.
          "ALLOW_PRIVATE_IP_ADDRESS=true",
          "ALLOW_META_IP_ADDRESS=true",
          `TZ=${config.timezone}`,
        ],
        Labels: { [ROLE]: "office" },
        HostConfig: { NetworkMode: config.docker.network, Memory: memory, MemorySwap: memory, RestartPolicy: { Name: "no" }, PidsLimit: 2048 },
      });
    }
    const c = this.#docker.getContainer(OFFICE_CONTAINER);
    try {
      await c.start();
    } catch (err: any) {
      if (err?.statusCode !== 304) throw err;
    }
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await this.#healthy()) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("编辑器启动超时，稍后再试，或在设置里查看状态");
  }

  async #healthy(): Promise<boolean> {
    try {
      const r = await fetch(`http://${OFFICE_CONTAINER}/healthcheck`, { signal: AbortSignal.timeout(3000) });
      return r.ok && (await r.text()).trim() === "true";
    } catch {
      return false;
    }
  }

  touch(): void {
    this.#lastUsed = Date.now();
  }

  async stop(): Promise<void> {
    try {
      await this.#docker.getContainer(OFFICE_CONTAINER).stop({ t: 10 });
    } catch (err: any) {
      if (err?.statusCode !== 404 && err?.statusCode !== 304) throw err;
    }
  }

  /** Remove the container and the image, freeing the disk. */
  async uninstall(): Promise<void> {
    await this.#docker.getContainer(OFFICE_CONTAINER).remove({ force: true }).catch(() => {});
    await this.#docker.getImage(this.image()).remove({ force: true }).catch(() => {});
    this.#pull = { active: false, percent: 0, error: null };
  }

  /** Stops the service after it has been idle for the configured time (it restarts on the next use). */
  startIdleStop(): void {
    this.#timer ??= setInterval(async () => {
      const idle = this.idleMinutes();
      if (idle <= 0 || !this.enabled() || this.#starting) return;
      if (Date.now() - this.#lastUsed < idle * 60_000) return;
      const running = await this.#docker.getContainer(OFFICE_CONTAINER).inspect().then((i) => i.State.Running, () => false);
      if (running) await this.stop().catch(() => {});
    }, 60_000);
    this.#timer.unref();
  }
}
