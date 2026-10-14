import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import * as OTPAuth from "otpauth";
import { config, newId, nowIso } from "./config.ts";
import { isTrusted } from "./trusted.ts";
import { audit, type Db } from "./db.ts";

export const SESSION_COOKIE = "cst_session";
const SESSION_DAYS = 30;

export interface UserRow {
  id: string;
  name: string;
  password_hash: string;
  totp_secret: string | null;
  created_at: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

/** Single-owner authentication: password (+TOTP) or passkeys, cookie sessions, one-time tickets. */
export class Auth {
  #db: Db;
  #challenges = new Map<string, { challenge: string; expires: number; userId?: string }>();
  #tickets = new Map<string, { purpose: string; data: unknown; expires: number }>();

  constructor(db: Db) {
    this.#db = db;
  }

  user(): UserRow | undefined {
    return this.#db.prepare("SELECT * FROM users LIMIT 1").get() as UserRow | undefined;
  }

  needsSetup(): boolean {
    return !this.user();
  }

  setup(code: string, name: string, password: string): UserRow {
    if (!this.needsSetup()) throw new Error("已经初始化");
    if (!config.setupCode || !safeEqual(code, config.setupCode)) throw new Error("初始化码错误");
    if (password.length < 10) throw new Error("密码至少 10 位");
    const id = newId("us");
    this.#db.prepare("INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)").run(id, name, hashPassword(password), nowIso());
    audit(this.#db, id, "auth.setup");
    return this.user()!;
  }

  loginPassword(password: string, totp: string | undefined): UserRow {
    const user = this.user();
    if (!user || !verifyPassword(password, user.password_hash)) throw new Error("密码错误");
    if (user.totp_secret) {
      if (!totp) throw Object.assign(new Error("需要验证码"), { code: "TOTP_REQUIRED" });
      if (!this.#checkTotp(user.totp_secret, totp)) throw new Error("验证码错误");
    }
    return user;
  }

  changePassword(current: string, next: string): void {
    const user = this.user()!;
    if (!verifyPassword(current, user.password_hash)) throw new Error("当前密码错误");
    if (next.length < 10) throw new Error("密码至少 10 位");
    this.#db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(next), user.id);
    audit(this.#db, user.id, "auth.password.change");
  }

  // ── TOTP ────────────────────────────────────────────────
  totpBegin(): { secret: string; uri: string } {
    const user = this.user()!;
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: "Constella", label: user.name, secret });
    return { secret: secret.base32, uri: totp.toString() };
  }

  totpEnable(secret: string, code: string): void {
    if (!this.#checkTotp(secret, code)) throw new Error("验证码错误");
    const user = this.user()!;
    this.#db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, user.id);
    audit(this.#db, user.id, "auth.totp.enable");
  }

  totpDisable(password: string): void {
    const user = this.user()!;
    if (!verifyPassword(password, user.password_hash)) throw new Error("密码错误");
    this.#db.prepare("UPDATE users SET totp_secret = NULL WHERE id = ?").run(user.id);
    audit(this.#db, user.id, "auth.totp.disable");
  }

  #checkTotp(secret: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
    return totp.validate({ token: code.replace(/\s/g, ""), window: 1 }) !== null;
  }

  // ── Passkeys ────────────────────────────────────────────
  rpFor(origin: string | undefined): { rpID: string; origin: string } {
    const o = (origin ?? "").replace(/\/$/, "");
    if (!config.origins.includes(o)) throw new Error(`不允许的来源：${o || "未知"}`);
    return { rpID: new URL(o).hostname, origin: o };
  }

  async passkeyRegisterOptions(origin: string | undefined): Promise<{ key: string; options: unknown }> {
    const { rpID } = this.rpFor(origin);
    const user = this.user()!;
    const existing = this.#db.prepare("SELECT id FROM passkeys WHERE rp_id = ?").all(rpID) as { id: string }[];
    const options = await generateRegistrationOptions({
      rpName: "Constella",
      rpID,
      userName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const key = this.#remember(options.challenge, user.id);
    return { key, options };
  }

  async passkeyRegisterVerify(origin: string | undefined, key: string, response: any, name: string): Promise<void> {
    const { rpID, origin: o } = this.rpFor(origin);
    const ch = this.#take(key);
    const v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: o, expectedRPID: rpID });
    if (!v.verified || !v.registrationInfo) throw new Error("通行密钥验证失败");
    const cred = v.registrationInfo.credential;
    this.#db
      .prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, rp_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(cred.id, ch.userId!, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), rpID, name, nowIso());
    audit(this.#db, ch.userId!, "auth.passkey.add", { name, rpID });
  }

  async passkeyLoginOptions(origin: string | undefined): Promise<{ key: string; options: unknown }> {
    const { rpID } = this.rpFor(origin);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    return { key: this.#remember(options.challenge), options };
  }

  async passkeyLoginVerify(origin: string | undefined, key: string, response: any): Promise<UserRow> {
    const { rpID, origin: o } = this.rpFor(origin);
    const ch = this.#take(key);
    const row = this.#db.prepare("SELECT * FROM passkeys WHERE id = ? AND rp_id = ?").get(response?.id, rpID) as any;
    if (!row) throw new Error("未知的通行密钥");
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: o,
      expectedRPID: rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports ?? "[]") },
    });
    if (!v.verified) throw new Error("通行密钥验证失败");
    this.#db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(v.authenticationInfo.newCounter, nowIso(), row.id);
    return this.user()!;
  }

  passkeys(): unknown[] {
    return this.#db.prepare("SELECT id, name, rp_id, created_at, last_used_at FROM passkeys ORDER BY created_at").all();
  }

  deletePasskey(id: string): void {
    this.#db.prepare("DELETE FROM passkeys WHERE id = ?").run(id);
  }

  #remember(challenge: string, userId?: string): string {
    const key = randomBytes(16).toString("base64url");
    this.#challenges.set(key, { challenge, userId, expires: Date.now() + 5 * 60_000 });
    for (const [k, v] of this.#challenges) if (v.expires < Date.now()) this.#challenges.delete(k);
    return key;
  }

  #take(key: string): { challenge: string; userId?: string } {
    const ch = this.#challenges.get(key);
    this.#challenges.delete(key);
    if (!ch || ch.expires < Date.now()) throw new Error("验证已过期，请重试");
    return ch;
  }

  // ── Sessions ────────────────────────────────────────────
  createSession(userId: string, req: FastifyRequest, reply: FastifyReply): void {
    const id = randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    this.#db
      .prepare("INSERT INTO sessions (id, user_id, device, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, describeDevice(String(req.headers["user-agent"] ?? "")), req.ip, now.toISOString(), now.toISOString(), expires.toISOString());
    audit(this.#db, userId, "auth.login", { ip: req.ip });
    reply.setCookie(SESSION_COOKIE, id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Secure whenever the request arrived over HTTPS (directly or via Tailscale Serve / cloudflared).
      secure: config.secureCookies && req.protocol === "https",
      expires,
    });
  }

  /** Validates the session cookie and slides its expiry; returns the user id. */
  check(req: FastifyRequest): { userId: string; sessionId: string } | null {
    if (isTrusted(req)) {
      const owner = this.user();
      return owner ? { userId: owner.id, sessionId: "trusted" } : null;
    }
    const id = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (!id) return null;
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!row || Date.parse(row.expires_at) < Date.now()) return null;
    if (Date.now() - Date.parse(row.last_seen_at) > 3600_000) {
      this.#db
        .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?")
        .run(nowIso(), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(), req.ip, id);
    }
    return { userId: row.user_id, sessionId: id };
  }

  logout(sessionId: string, reply: FastifyReply): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  sessions(currentId: string): unknown[] {
    return (this.#db.prepare("SELECT id, device, ip, created_at, last_seen_at FROM sessions ORDER BY last_seen_at DESC").all() as any[]).map((s) => ({
      ...s,
      id: s.id.slice(0, 12),
      current: s.id === currentId,
    }));
  }

  revokeSession(prefix: string): void {
    if (prefix.length < 12) throw new Error("invalid id");
    this.#db.prepare("DELETE FROM sessions WHERE substr(id, 1, 12) = ?").run(prefix);
  }

  // ── One-time tickets (WebSocket URLs can't carry cookies reliably cross-origin) ──
  issueTicket(purpose: string, data: unknown, ttlMs = 30_000): string {
    const t = randomBytes(24).toString("base64url");
    this.#tickets.set(t, { purpose, data, expires: Date.now() + ttlMs });
    for (const [k, v] of this.#tickets) if (v.expires < Date.now()) this.#tickets.delete(k);
    return t;
  }

  consumeTicket<T>(ticket: string, purpose: string): T | null {
    const t = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!t || t.expires < Date.now() || t.purpose !== purpose) return null;
    return t.data as T;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function describeDevice(ua: string): string {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "未知系统";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "浏览器";
  return `${os} · ${browser}`;
}
