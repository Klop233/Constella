import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

/** AES-256-GCM with the master key from deploy/.env; values are stored as iv.tag.ciphertext (base64url). */
export class SecretBox {
  #key: Buffer;

  constructor(masterKeyB64: string) {
    const key = Buffer.from(masterKeyB64, "base64");
    if (key.length !== 32) throw new Error("CONSTELLA_MASTER_KEY must be 32 bytes, base64-encoded");
    this.#key = key;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
  }

  open(sealed: string): string {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || !tag || !body) throw new Error("malformed secret");
    const d = createDecipheriv("aes-256-gcm", this.#key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  }
}

export class SecretStore {
  #db: Db;
  #box: SecretBox;

  constructor(db: Db, box: SecretBox) {
    this.#db = db;
    this.#box = box;
  }

  get(scope: string, name: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM secrets WHERE scope = ? AND name = ?").get(scope, name) as
      | { value: string }
      | undefined;
    return row ? this.#box.open(row.value) : undefined;
  }

  set(scope: string, name: string, value: string): void {
    this.#db
      .prepare("INSERT INTO secrets (scope, name, value) VALUES (?, ?, ?) ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value")
      .run(scope, name, this.#box.seal(value));
  }

  delete(scope: string, name: string): void {
    this.#db.prepare("DELETE FROM secrets WHERE scope = ? AND name = ?").run(scope, name);
  }

  names(scope: string): string[] {
    return (this.#db.prepare("SELECT name FROM secrets WHERE scope = ? ORDER BY name").all(scope) as { name: string }[]).map(
      (r) => r.name,
    );
  }

  /** All secrets of a scope, for injecting into an agent container. */
  all(scope: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.names(scope)) out[name] = this.get(scope, name)!;
    return out;
  }
}

/** Replace any known secret value appearing in text (event logs, tool output). */
export function redact(text: string, values: Iterable<string>): string {
  let out = text;
  for (const v of values) if (v && v.length >= 6) out = out.split(v).join("«secret»");
  return out;
}
