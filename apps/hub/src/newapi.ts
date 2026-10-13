import { config } from "./config.ts";

export interface ModelInfo {
  id: string;
  /** Result of the phase 0 compatibility run (docs/spikes/models.md), if known. */
  compat?: "ok" | "upstream_error";
}

/** Known results from docs/spikes/models.md; refreshed by re-running scripts/spikes/model-compat.sh. */
const COMPAT: Record<string, ModelInfo["compat"]> = {
  "gpt-6-astra": "ok",
  "gpt-5.6-sol": "ok",
  "mimo-v2.5-pro": "ok",
};

/** new-api quota units per USD (new-api's default QuotaPerUnit). */
const QUOTA_PER_USD = 500_000;

/** Thin client for new-api: OpenAI-compatible endpoints plus the optional admin API. */
export class NewApi {
  #baseUrl: string;
  #apiKey: () => string;
  #admin: () => { token: string; userId: string } | null;
  #modelsCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(opts: {
    baseUrl: string;
    apiKey: () => string;
    admin: () => { token: string; userId: string } | null;
  }) {
    this.#baseUrl = opts.baseUrl;
    this.#apiKey = opts.apiKey;
    this.#admin = opts.admin;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async models(force = false): Promise<ModelInfo[]> {
    if (!force && this.#modelsCache && Date.now() - this.#modelsCache.at < 5 * 60_000) return this.#modelsCache.models;
    const res = await fetch(`${this.#baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${this.#apiKey()}` } });
    if (!res.ok) throw new Error(`new-api /v1/models ${res.status}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    const models = (body.data ?? [])
      .map((m) => ({ id: m.id, compat: COMPAT[m.id] }))
      .sort((a, b) => Number(!!b.compat) - Number(!!a.compat) || a.id.localeCompare(b.id));
    this.#modelsCache = { at: Date.now(), models };
    return models;
  }

  /** Chat completion that must return a JSON object (used for reflection and curation). */
  async chatJson(model: string, system: string, user: string, timeoutMs = 120_000): Promise<unknown> {
    const res = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`new-api chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? "";
    return parseJsonLoose(content);
  }

  adminEnabled(): boolean {
    return this.#admin() !== null;
  }

  async #adminFetch(path: string, init: RequestInit = {}): Promise<any> {
    const admin = this.#admin();
    if (!admin) throw new Error("未配置 new-api 管理令牌");
    const res = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: admin.token,
        "New-Api-User": admin.userId,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; data?: unknown };
    if (!res.ok || body.success === false) throw new Error(`new-api ${path}: ${body.message ?? res.status}`);
    return body.data;
  }

  /** Create a dedicated token for an agent; returns its id and key. Quota in USD (null = unlimited). */
  async createToken(name: string, quotaUsd: number | null): Promise<{ id: number; key: string }> {
    await this.#adminFetch("/api/token/", {
      method: "POST",
      body: JSON.stringify({
        name,
        expired_time: -1,
        remain_quota: quotaUsd === null ? 0 : Math.round(quotaUsd * QUOTA_PER_USD),
        unlimited_quota: quotaUsd === null,
        model_limits_enabled: false,
      }),
    });
    const list = (await this.#adminFetch(`/api/token/?p=1&size=100&keyword=${encodeURIComponent(name)}`)) as any;
    const items: any[] = Array.isArray(list) ? list : (list?.items ?? []);
    const token = items.find((t) => t.name === name);
    if (!token) throw new Error("token created but not found");
    const key = String(token.key).startsWith("sk-") ? token.key : `sk-${token.key}`;
    return { id: token.id, key };
  }

  async deleteToken(id: number): Promise<void> {
    await this.#adminFetch(`/api/token/${id}`, { method: "DELETE" });
  }

  /** Spend (USD) per token name since a unix timestamp, from new-api's consumption logs. */
  async spendByToken(since: number): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (let page = 1; page <= 20; page++) {
      const data = (await this.#adminFetch(
        `/api/log/?p=${page}&page_size=100&type=2&start_timestamp=${since}&end_timestamp=${Math.floor(Date.now() / 1000)}`,
      )) as any;
      const items: any[] = Array.isArray(data) ? data : (data?.items ?? []);
      for (const it of items) out[it.token_name] = (out[it.token_name] ?? 0) + (it.quota ?? 0) / QUOTA_PER_USD;
      if (items.length < 100) break;
    }
    return out;
  }
}

export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("model did not return JSON");
  }
}

export function defaultNewApi(): NewApi {
  return new NewApi({
    baseUrl: config.newapi.baseUrl,
    apiKey: () => config.newapi.apiKey,
    admin: () => (config.newapi.adminToken ? { token: config.newapi.adminToken, userId: config.newapi.adminUserId } : null),
  });
}
