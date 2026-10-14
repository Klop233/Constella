import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SecretStore } from "./secrets.ts";

export interface CredentialConnection { id: string; name: string; provider: "bitwarden"; server: string }
export interface CredentialItem { id: string; name: string; username?: string; uris: string[]; fields: string[] }
export interface CredentialProvider {
  unlocked(id: string): boolean;
  unlock(connection: CredentialConnection, password: string): Promise<void>;
  lock(id: string): void;
  sync(connection: CredentialConnection): Promise<void>;
  items(connection: CredentialConnection): Promise<CredentialItem[]>;
  read(connection: CredentialConnection, itemId: string, fields: string[]): Promise<Record<string, string>>;
}
interface VaultItem { id: string; name?: string; type?: number; login?: { username?: string; password?: string; totp?: string; uris?: { uri?: string }[] }; fields?: { name?: string; value?: string; type?: number }[] }
const SESSION_MS = 15 * 60_000;
/** CLI output is never included in errors: stderr can contain vault data and authentication material. */
export class BitwardenProvider implements CredentialProvider {
  #secrets: SecretStore;
  #root: string;
  #sessions = new Map<string, { key: string; expires: number; timer: NodeJS.Timeout }>();
  #epochs = new Map<string, number>();
  #queues = new Map<string, Promise<unknown>>();
  constructor(secrets: SecretStore, root: string) { this.#secrets = secrets; this.#root = root; }
  unlocked(id: string): boolean {
    const s = this.#sessions.get(id);
    if (s && s.expires > Date.now()) return true;
    if (s) this.lock(id);
    return false;
  }
  lock(id: string): void {
    const s = this.#sessions.get(id);
    if (s) clearTimeout(s.timer);
    this.#sessions.delete(id);
    this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1);
  }
  async #serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#queues.set(id, next);
    try { return await next; } finally { if (this.#queues.get(id) === next) this.#queues.delete(id); }
  }
  async #command(c: CredentialConnection, args: string[], extra: Record<string, string> = {}): Promise<string> {
    if (!/^cred_[a-zA-Z0-9_-]+$/.test(c.id)) throw new Error("凭据连接无效");
    const dir = path.join(this.#root, c.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, BITWARDENCLI_APPDATA_DIR: dir, BW_NOINTERACTION: "true", ...extra };
    return new Promise((resolve, reject) => {
      execFile("bw", args, { env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) reject(new Error("Bitwarden 操作失败，请检查连接、登录信息或解锁状态"));
        else resolve(stdout.trim());
      });
    });
  }
  async unlock(c: CredentialConnection, password: string): Promise<void> {
    this.lock(c.id);
    const epoch = this.#epochs.get(c.id);
    await this.#serial(c.id, async () => {
      const status = JSON.parse(await this.#command(c, ["status"])) as { status: string };
      if (status.status !== "unauthenticated") await this.#command(c, ["logout"]);
      await this.#command(c, ["config", "server", c.server === "us" ? "https://vault.bitwarden.com" : c.server === "eu" ? "https://vault.bitwarden.eu" : c.server]);
      const scope = `credentials.${c.id}`;
      const clientId = this.#secrets.get(scope, "clientId");
      const clientSecret = this.#secrets.get(scope, "clientSecret");
      if (!clientId || !clientSecret) throw new Error("连接登录信息缺失");
      await this.#command(c, ["login", "--apikey"], { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret });
      const key = await this.#command(c, ["unlock", "--passwordenv", "CONSTELLA_BW_PASSWORD", "--raw"], { CONSTELLA_BW_PASSWORD: password });
      if (!key || epoch !== this.#epochs.get(c.id)) throw new Error("解锁已取消");
      const timer = setTimeout(() => this.lock(c.id), SESSION_MS); timer.unref();
      this.#sessions.set(c.id, { key, expires: Date.now() + SESSION_MS, timer });
    });
  }
  async #withSession<T>(c: CredentialConnection, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    return this.#serial(c.id, async () => {
      if (!this.unlocked(c.id)) throw new Error("请先解锁凭据连接");
      const session = this.#sessions.get(c.id)!;
      const result = await fn({ BW_SESSION: session.key });
      if (!this.unlocked(c.id) || this.#sessions.get(c.id) !== session) throw new Error("凭据连接已锁定");
      return result;
    });
  }
  async sync(c: CredentialConnection): Promise<void> { await this.#withSession(c, async (env) => { await this.#command(c, ["sync"], env); }); }
  async items(c: CredentialConnection): Promise<CredentialItem[]> {
    return this.#withSession(c, async (env) => {
      const items = JSON.parse(await this.#command(c, ["list", "items"], env)) as VaultItem[];
      if (!Array.isArray(items)) throw new Error("Bitwarden 返回格式无效");
      return items.filter(i => i.type === 1 && typeof i.id === "string").map(i => ({
        id: i.id, name: String(i.name ?? "").slice(0, 200),
        ...(i.login?.username ? { username: i.login.username.slice(0, 300) } : {}),
        uris: (i.login?.uris ?? []).flatMap(u => typeof u.uri === "string" ? [u.uri.slice(0, 2000)] : []).slice(0, 20),
        fields: [ ...(i.login?.username != null ? ["login.username"] : []), ...(i.login?.password != null ? ["login.password"] : []), ...(i.login?.totp ? ["login.totp"] : []) ],
      }));
    });
  }
  async read(c: CredentialConnection, itemId: string, fields: string[]): Promise<Record<string, string>> {
    return this.#withSession(c, async (env) => {
      const item = JSON.parse(await this.#command(c, ["get", "item", itemId], env)) as VaultItem;
      if (item.id !== itemId || item.type !== 1) throw new Error("凭据条目无效");
      const result: Record<string, string> = {};
      for (const field of fields) {
        const value = field === "login.totp" ? await this.#command(c, ["get", "totp", itemId], env) : field === "login.username" ? item.login?.username : field === "login.password" ? item.login?.password : undefined;
        if (typeof value !== "string") throw new Error("请求的凭据字段不可用");
        result[field] = value;
      }
      return result;
    });
  }
}
