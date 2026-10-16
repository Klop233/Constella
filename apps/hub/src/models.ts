import type { EngineProvider } from "@constella/protocol";
import { config, nowIso } from "./config.ts";
import { kvGet, kvSet, type Db } from "./db.ts";
import { chatJson } from "./llm.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * Model providers (OpenAI-compatible endpoints) and the models picked from them. A provider speaks either the
 * Responses API, which Codex calls directly, or Chat Completions, which the hub bridges (chatbridge.ts).
 * A model is referenced as "model@provider"; a bare name resolves to the provider marked as default. There is no
 * special-cased upstream.
 */

/** Provider ids are opaque ("p-…"), which is what tells a "model@provider" ref from a model that just has an "@". */
const PROVIDER_ID = /^p-[a-z0-9-]+$/;

export const PROVIDER_APIS = ["responses", "chat"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

export interface Provider {
  id: string;
  name: string;
  /** OpenAI-compatible API base, ending in /v1 for most gateways. */
  baseUrl: string;
  api: ProviderApi;
  /** The provider bare model names resolve to; exactly one at a time. */
  default: boolean;
}

/** Where agent containers reach the hub's Chat Completions bridge for a provider. */
export function bridgeUrl(providerId: string): string {
  return `${new URL(config.docker.hubMcpUrl).origin}/api/llm/${providerId}/v1`;
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
  return provider ? `${model}@${provider}` : model;
}

export class ModelRegistry {
  #db: Db;
  #secrets: SecretStore;

  constructor(deps: { db: Db; secrets: SecretStore }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
  }

  // ── providers ──────────────────────────────────────────

  /** The provider bare model names resolve to: the chosen one while it exists, else the oldest one. */
  defaultProviderId(): string {
    const rows = this.#db.prepare("SELECT id FROM providers ORDER BY created_at, rowid").all() as { id: string }[];
    const chosen = kvGet(this.#db, "settings.defaultProvider");
    if (chosen && rows.some((r) => r.id === chosen)) return chosen;
    return rows[0]?.id ?? "";
  }

  providers(): Provider[] {
    const rows = this.#db.prepare("SELECT id, name, base_url, api FROM providers ORDER BY created_at, rowid").all() as { id: string; name: string; base_url: string; api: string }[];
    const def = this.defaultProviderId();
    return rows.map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url, api: r.api === "chat" ? ("chat" as const) : ("responses" as const), default: r.id === def }));
  }

  provider(id: string): Provider | undefined {
    return this.providers().find((p) => p.id === id);
  }

  setDefaultProvider(id: string): void {
    if (!this.provider(id)) throw new Error("服务商不存在");
    kvSet(this.#db, "settings.defaultProvider", id);
  }

  apiKey(id: string): string {
    return this.#secrets.get(`provider:${id}`, "apiKey") ?? "";
  }

  /** Every provider key, for redaction. */
  keys(): string[] {
    return this.providers().map((p) => this.apiKey(p.id)).filter(Boolean);
  }

  addProvider(input: { name: string; baseUrl: string; apiKey: string; api?: ProviderApi }): Provider {
    const name = input.name.trim();
    if (this.providers().some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`已有名为「${name}」的服务商`);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "provider";
    let id = `p-${slug}`;
    for (let i = 2; this.provider(id); i++) id = `p-${slug}-${i}`;
    const first = this.providers().length === 0;
    this.#db
      .prepare("INSERT INTO providers (id, name, base_url, api, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, normalizeUrl(input.baseUrl), input.api ?? "responses", nowIso());
    if (input.apiKey) this.#secrets.set(`provider:${id}`, "apiKey", input.apiKey);
    if (first) kvSet(this.#db, "settings.defaultProvider", id);
    return this.provider(id)!;
  }

  updateProvider(id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; api?: ProviderApi }): Provider {
    const cur = this.provider(id);
    if (!cur) throw new Error("服务商不存在");
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (this.providers().some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`已有名为「${name}」的服务商`);
      this.#db.prepare("UPDATE providers SET name = ? WHERE id = ?").run(name, id);
    }
    if (patch.baseUrl !== undefined) this.#db.prepare("UPDATE providers SET base_url = ? WHERE id = ?").run(normalizeUrl(patch.baseUrl), id);
    if (patch.api !== undefined) this.#db.prepare("UPDATE providers SET api = ? WHERE id = ?").run(patch.api, id);
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
    if (!this.provider(id)) throw new Error("服务商不存在");
    this.#db.prepare("DELETE FROM models WHERE provider = ?").run(id);
    this.#db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    this.#secrets.delete(`provider:${id}`, "apiKey");
    if (kvGet(this.#db, "settings.defaultProvider") === id) kvSet(this.#db, "settings.defaultProvider", "");
  }

  /** Model ids the provider serves (GET /models). */
  async remoteModels(id: string): Promise<string[]> {
    const p = this.provider(id);
    if (!p) throw new Error("服务商不存在");
    return listRemoteModels(p.baseUrl, this.apiKey(id), p.name);
  }

  /**
   * What the runner needs to point Codex at a provider. A Chat Completions provider goes through the hub's bridge,
   * authenticated with the agent's own token, so its key never enters the container.
   */
  engineProvider(id: string): EngineProvider {
    const p = this.provider(id);
    if (!p) throw new Error(id ? `模型的服务商（${id}）不存在，请在「设置 → 模型」里重新选一个` : "还没有配置模型服务商，请先在「设置 → 模型」里添加");
    if (p.api === "chat") return { id: p.id, name: p.name, baseUrl: bridgeUrl(p.id), envKey: "CONSTELLA_AGENT_TOKEN" };
    return { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: this.apiKey(p.id) };
  }

  // ── models ─────────────────────────────────────────────

  /** Splits a ref at its last "@" when what follows looks like a provider id; anything else is a bare model. */
  parse(ref: string): { model: string; provider: string } {
    const at = ref.lastIndexOf("@");
    if (at > 0) {
      const provider = ref.slice(at + 1);
      if (PROVIDER_ID.test(provider)) return { model: ref.slice(0, at), provider };
    }
    return { model: ref, provider: this.defaultProviderId() };
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
    if (!this.provider(provider)) throw new Error("服务商不存在");
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

  /**
   * Ask the model for a one-word reply with the same streaming call the agent will make (Responses API, or Chat
   * Completions for a bridged provider) and remember whether it worked.
   */
  async test(ref: string): Promise<{ ok: boolean; ms: number; error: string | null; reply: string }> {
    const { model, provider } = this.parse(ref);
    const p = this.provider(provider);
    if (!p) throw new Error("服务商不存在");
    const started = Date.now();
    let ok = false;
    let error: string | null = null;
    let reply = "";
    try {
      const chat = p.api === "chat";
      const res = await fetch(`${p.baseUrl}/${chat ? "chat/completions" : "responses"}`, {
        method: "POST",
        headers: { ...authHeader(this.apiKey(provider)), "Content-Type": "application/json" },
        body: JSON.stringify(
          chat
            ? {
                model,
                messages: [
                  { role: "system", content: "You are a connectivity check." },
                  { role: "user", content: "Reply with the single word OK." },
                ],
                stream: true,
              }
            : {
                model,
                instructions: "You are a connectivity check.",
                input: [{ role: "user", content: [{ type: "input_text", text: "Reply with the single word OK." }] }],
                stream: true,
                store: false,
              },
        ),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok || !res.body) throw new Error(httpHint(res.status, (await res.text()).slice(0, 200), chat));
      const result = chat ? await readChatStream(res.body) : await readResponseStream(res.body);
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
    if (!p) return Promise.reject(new Error(`模型的 provider（${provider}）不存在，请在「设置 → 模型」里重新选一个`));
    return chatJson({ baseUrl: p.baseUrl, apiKey: this.apiKey(provider) }, model, system, user, timeoutMs);
  }
}

/** Model ids an arbitrary OpenAI-compatible address serves; shared with the first-run wizard, which has no provider row yet. */
export async function listRemoteModels(baseUrl: string, apiKey: string, name: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, { headers: authHeader(apiKey), signal: AbortSignal.timeout(15_000) }).catch((err) => {
    throw new Error(`连不上 ${base}：${err instanceof Error ? err.message : err}`);
  });
  if (!res.ok) {
    const hint = res.status === 404 && !/\/v\d+$/.test(base) ? "（地址通常以 /v1 结尾）" : res.status === 401 || res.status === 403 ? "（检查 API Key）" : "";
    throw new Error(`${name} /models 返回 ${res.status}${hint}`);
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
  return [...new Set((body.data ?? []).map((m) => m.id).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(u)) throw new Error("地址要以 http:// 或 https:// 开头");
  return u;
}

/** An HTTP failure in words, with a hint when the API format looks wrong. */
function httpHint(status: number, body: string, chat: boolean): string {
  const hint =
    status === 401 || status === 403
      ? "（检查 API Key）"
      : status === 404 || status === 405
        ? chat
          ? "（地址通常以 /v1 结尾）"
          : "（这个服务可能不支持 Responses 接口，把接口格式换成 Chat Completions 试试）"
        : "";
  return `HTTP ${status}${hint}：${body}`;
}

function authHeader(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Reads a Responses API event stream until it completes or fails. */
async function readResponseStream(body: ReadableStream<Uint8Array>): Promise<{ ok: boolean; error: string | null; text: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
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

/** Reads a Chat Completions event stream until [DONE]. */
async function readChatStream(body: ReadableStream<Uint8Array>): Promise<{ ok: boolean; error: string | null; text: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return { ok: true, error: null, text };
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.error) return { ok: false, error: ev.error.message ?? JSON.stringify(ev.error).slice(0, 200), text };
        const choice = ev.choices?.[0];
        text += choice?.delta?.content ?? "";
        if (choice?.finish_reason) finished = true;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return finished || text ? { ok: true, error: null, text } : { ok: false, error: "流在完成前结束", text };
}
