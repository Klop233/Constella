import type { EngineProvider } from "@constella/protocol";
import { nowIso } from "./config.ts";
import { kvGet, kvSet, type Db } from "./db.ts";
import { chatJson } from "./newapi.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * Model providers (OpenAI-compatible endpoints that speak the Responses API) and the models picked from them.
 * A model is referenced as "model@provider"; models of the built-in new-api keep their bare name, as before
 * providers existed, so stored agents and runs stay valid.
 */

export const BUILTIN = "newapi";

export interface Provider {
  id: string;
  name: string;
  /** OpenAI-compatible API base, ending in /v1 for most gateways. */
  baseUrl: string;
  builtin: boolean;
}

export type { EngineProvider };

export interface ModelEntry {
  ref: string;
  model: string;
  provider: string;
  providerName: string;
  /** Display name: "model (provider)", or just "model" for the one entry of a name marked to omit the provider. */
  label: string;
  bare: boolean;
  test: { ok: boolean; ms: number | null; error: string | null; at: string } | null;
}

interface ModelRow {
  model: string;
  provider: string;
  bare: number;
  test_ok: number | null;
  test_ms: number | null;
  test_error: string | null;
  tested_at: string | null;
}

export type NameFormat = "paren" | "dash";

export function joinRef(model: string, provider: string): string {
  return provider === BUILTIN ? model : `${model}@${provider}`;
}

export class ModelRegistry {
  #db: Db;
  #secrets: SecretStore;
  #builtin: { baseUrl: string; apiKey: () => string };
  #seeding: Promise<void> | null = null;

  constructor(deps: { db: Db; secrets: SecretStore; newapiBaseUrl: string; newapiKey: () => string }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#builtin = { baseUrl: `${deps.newapiBaseUrl.replace(/\/$/, "")}/v1`, apiKey: deps.newapiKey };
  }

  // ── providers ──────────────────────────────────────────

  providers(): Provider[] {
    const rows = this.#db.prepare("SELECT id, name, base_url FROM providers ORDER BY created_at").all() as { id: string; name: string; base_url: string }[];
    return [{ id: BUILTIN, name: "new-api", baseUrl: this.#builtin.baseUrl, builtin: true }, ...rows.map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url, builtin: false }))];
  }

  provider(id: string): Provider | undefined {
    return this.providers().find((p) => p.id === id);
  }

  apiKey(id: string): string {
    return id === BUILTIN ? this.#builtin.apiKey() : (this.#secrets.get(`provider:${id}`, "apiKey") ?? "");
  }

  /** Every provider key, for redaction. */
  keys(): string[] {
    return this.providers().map((p) => this.apiKey(p.id)).filter(Boolean);
  }

  addProvider(input: { name: string; baseUrl: string; apiKey: string }): Provider {
    const name = input.name.trim();
    if (this.providers().some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`已有名为「${name}」的 provider`);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "provider";
    let id = `p-${slug}`;
    for (let i = 2; this.provider(id); i++) id = `p-${slug}-${i}`;
    this.#db.prepare("INSERT INTO providers (id, name, base_url, created_at) VALUES (?, ?, ?, ?)").run(id, name, normalizeUrl(input.baseUrl), nowIso());
    if (input.apiKey) this.#secrets.set(`provider:${id}`, "apiKey", input.apiKey);
    return this.provider(id)!;
  }

  updateProvider(id: string, patch: { name?: string; baseUrl?: string; apiKey?: string }): Provider {
    const cur = this.provider(id);
    if (!cur) throw new Error("provider 不存在");
    if (cur.builtin) throw new Error("内置的 new-api 在 deploy/.env 里配置");
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (this.providers().some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`已有名为「${name}」的 provider`);
      this.#db.prepare("UPDATE providers SET name = ? WHERE id = ?").run(name, id);
    }
    if (patch.baseUrl !== undefined) this.#db.prepare("UPDATE providers SET base_url = ? WHERE id = ?").run(normalizeUrl(patch.baseUrl), id);
    // An empty key leaves the stored one alone; keys are replaced, never shown again.
    if (patch.apiKey) this.#secrets.set(`provider:${id}`, "apiKey", patch.apiKey);
    return this.provider(id)!;
  }

  /** Refs still pointing at a provider (agents, conversations, defaults), so it isn't removed from under them. */
  usersOf(id: string, defaults: string[]): string[] {
    const agents = this.#db.prepare("SELECT name, model FROM agents WHERE archived = 0").all() as { name: string; model: string }[];
    const out = agents.filter((a) => this.parse(a.model).provider === id).map((a) => `agent「${a.name}」`);
    const convs = (this.#db.prepare("SELECT model FROM conversations WHERE model IS NOT NULL").all() as { model: string }[]).filter((c) => this.parse(c.model).provider === id);
    if (convs.length) out.push(`${convs.length} 个对话`);
    if (defaults.some((d) => this.parse(d).provider === id)) out.push("默认模型设置");
    return out;
  }

  removeProvider(id: string): void {
    if (id === BUILTIN) throw new Error("内置的 new-api 不能删除");
    this.#db.prepare("DELETE FROM models WHERE provider = ?").run(id);
    this.#db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    this.#secrets.delete(`provider:${id}`, "apiKey");
  }

  /** Model ids the provider serves (GET /models). */
  async remoteModels(id: string): Promise<string[]> {
    const p = this.provider(id);
    if (!p) throw new Error("provider 不存在");
    const res = await fetch(`${p.baseUrl}/models`, { headers: authHeader(this.apiKey(id)), signal: AbortSignal.timeout(15_000) }).catch((err) => {
      throw new Error(`连不上 ${p.baseUrl}：${err instanceof Error ? err.message : err}`);
    });
    if (!res.ok) {
      const hint = res.status === 404 && !/\/v\d+$/.test(p.baseUrl) ? "（地址通常以 /v1 结尾）" : res.status === 401 || res.status === 403 ? "（检查 API Key）" : "";
      throw new Error(`${p.name} /models 返回 ${res.status}${hint}`);
    }
    const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
    return [...new Set((body.data ?? []).map((m) => m.id).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  /** What the runner needs to point Codex at a provider; the built-in one uses the agent's own new-api token from its environment. */
  engineProvider(id: string): EngineProvider {
    const p = this.provider(id);
    if (!p) throw new Error(`模型的 provider（${id}）已被删除，请换一个模型`);
    return p.builtin ? { id: p.id, name: p.name, baseUrl: p.baseUrl, envKey: "NEWAPI_API_KEY" } : { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: this.apiKey(p.id) };
  }

  // ── models ─────────────────────────────────────────────

  /** Splits a ref at its last "@" when what follows names a provider; anything else is a bare new-api model. */
  parse(ref: string): { model: string; provider: string } {
    const at = ref.lastIndexOf("@");
    if (at > 0) {
      const provider = ref.slice(at + 1);
      if (provider === BUILTIN || /^p-[a-z0-9-]+$/.test(provider)) return { model: ref.slice(0, at), provider };
    }
    return { model: ref, provider: BUILTIN };
  }

  normalize(ref: string): string {
    const p = this.parse(ref);
    return joinRef(p.model, p.provider);
  }

  /** Model name and provider settings for starting a run. */
  resolve(ref: string): { model: string; provider: EngineProvider } {
    const p = this.parse(ref);
    return { model: p.model, provider: this.engineProvider(p.provider) };
  }

  nameFormat(): NameFormat {
    return kvGet(this.#db, "settings.modelNameFormat") === "dash" ? "dash" : "paren";
  }

  label(ref: string, rows = this.#rows(), providers = this.providers()): string {
    const p = this.parse(ref);
    if (rows.some((r) => r.model === p.model && r.provider === p.provider && r.bare)) return p.model;
    const name = providers.find((x) => x.id === p.provider)?.name ?? p.provider;
    return this.nameFormat() === "dash" ? `${p.model} - ${name}` : `${p.model} (${name})`;
  }

  #rows(): ModelRow[] {
    return this.#db.prepare("SELECT * FROM models").all() as unknown as ModelRow[];
  }

  list(): ModelEntry[] {
    const rows = this.#rows();
    const providers = this.providers();
    const order = new Map(providers.map((p, i) => [p.id, i]));
    return rows
      .filter((r) => order.has(r.provider))
      .map((r) => {
        const ref = joinRef(r.model, r.provider);
        return {
          ref,
          model: r.model,
          provider: r.provider,
          providerName: providers.find((p) => p.id === r.provider)!.name,
          label: this.label(ref, rows, providers),
          bare: !!r.bare,
          test: r.tested_at ? { ok: !!r.test_ok, ms: r.test_ms, error: r.test_error, at: r.tested_at } : null,
        };
      })
      .sort((a, b) => order.get(a.provider)! - order.get(b.provider)! || a.model.localeCompare(b.model));
  }

  add(provider: string, models: string[]): number {
    if (!this.provider(provider)) throw new Error("provider 不存在");
    const ins = this.#db.prepare("INSERT OR IGNORE INTO models (model, provider, bare, created_at) VALUES (?, ?, 0, ?)");
    let n = 0;
    for (const m of models.map((x) => x.trim()).filter(Boolean)) n += Number(ins.run(m, provider, nowIso()).changes);
    return n;
  }

  remove(ref: string): void {
    const p = this.parse(ref);
    this.#db.prepare("DELETE FROM models WHERE model = ? AND provider = ?").run(p.model, p.provider);
  }

  /** At most one entry per model name drops the provider from its display name. */
  setBare(ref: string, bare: boolean): void {
    const p = this.parse(ref);
    if (bare) this.#db.prepare("UPDATE models SET bare = 0 WHERE model = ?").run(p.model);
    this.#db.prepare("UPDATE models SET bare = ? WHERE model = ? AND provider = ?").run(bare ? 1 : 0, p.model, p.provider);
  }

  /** First start with providers: take over every model the built-in new-api serves, so nothing disappears from the pickers. */
  seed(): Promise<void> {
    if (kvGet(this.#db, "models.seeded")) return Promise.resolve();
    this.#seeding ??= (async () => {
      try {
        const ids = await this.remoteModels(BUILTIN);
        const inUse = (this.#db.prepare("SELECT model FROM agents UNION SELECT value FROM kv WHERE key IN ('settings.defaultModel','settings.reflectModel')").all() as { model: string }[])
          .map((r) => this.parse(r.model))
          .filter((p) => p.provider === BUILTIN)
          .map((p) => p.model);
        this.add(BUILTIN, [...ids, ...inUse]);
        kvSet(this.#db, "models.seeded", nowIso());
      } catch (err) {
        console.error("model seeding failed", err instanceof Error ? err.message : err);
      } finally {
        this.#seeding = null;
      }
    })();
    return this.#seeding;
  }

  /**
   * Ask the model for a one-word reply through the Responses API — the same streaming call Codex makes —
   * and remember whether it worked.
   */
  async test(ref: string): Promise<{ ok: boolean; ms: number; error: string | null; reply: string }> {
    const { model, provider } = this.parse(ref);
    const p = this.provider(provider);
    if (!p) throw new Error("provider 不存在");
    const started = Date.now();
    let ok = false;
    let error: string | null = null;
    let reply = "";
    try {
      const res = await fetch(`${p.baseUrl}/responses`, {
        method: "POST",
        headers: { ...authHeader(this.apiKey(provider)), "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: "You are a connectivity check.",
          input: [{ role: "user", content: [{ type: "input_text", text: "Reply with the single word OK." }] }],
          stream: true,
          store: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      const result = await readResponseStream(res.body);
      ok = result.ok;
      error = result.error;
      reply = result.text;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = Date.now() - started;
    this.#db
      .prepare("UPDATE models SET test_ok = ?, test_ms = ?, test_error = ?, tested_at = ? WHERE model = ? AND provider = ?")
      .run(ok ? 1 : 0, ms, error ? error.slice(0, 300) : null, nowIso(), model, provider);
    return { ok, ms, error, reply: reply.slice(0, 100) };
  }

  /** JSON-object chat completion on the provider behind `ref` (reflection, curation, summaries). */
  chatJson(ref: string, system: string, user: string, timeoutMs?: number): Promise<unknown> {
    const { model, provider } = this.parse(ref);
    const p = this.provider(provider);
    if (!p) return Promise.reject(new Error(`模型的 provider（${provider}）已被删除`));
    return chatJson({ baseUrl: p.baseUrl, apiKey: this.apiKey(provider) }, model, system, user, timeoutMs);
  }
}

function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(u)) throw new Error("地址要以 http:// 或 https:// 开头");
  return u;
}

function authHeader(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Reads a Responses API event stream until it completes or fails. */
async function readResponseStream(body: ReadableStream<Uint8Array>): Promise<{ ok: boolean; error: string | null; text: string }> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        let ev: any;
        try {
          ev = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (ev.type === "response.output_text.delta") text += ev.delta ?? "";
        if (ev.type === "response.completed" || ev.type === "response.incomplete") return { ok: true, error: null, text };
        if (ev.type === "response.failed") return { ok: false, error: ev.response?.error?.message ?? "response.failed", text };
        if (ev.type === "error") return { ok: false, error: ev.message ?? ev.error?.message ?? "error", text };
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text ? { ok: true, error: null, text } : { ok: false, error: "流在完成前结束（provider 可能不支持 Responses API）", text };
}
