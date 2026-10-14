/** new-api quota units per USD (new-api's default QuotaPerUnit). */
const QUOTA_PER_USD = 500_000;

/** Admin API of the built-in new-api: per-agent tokens and spend (model calls go through ModelRegistry). */
export class NewApi {
  #baseUrl: string;
  #admin: () => { token: string; userId: string } | null;

  constructor(opts: { baseUrl: string; admin: () => { token: string; userId: string } | null }) {
    this.#baseUrl = opts.baseUrl;
    this.#admin = opts.admin;
  }

  get baseUrl(): string {
    return this.#baseUrl;
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

/** Chat completion on an OpenAI-compatible endpoint that must return a JSON object (reflection, curation, summaries). */
export async function chatJson(
  endpoint: { baseUrl: string; apiKey: string },
  model: string,
  system: string,
  user: string,
  timeoutMs = 120_000,
): Promise<unknown> {
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
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
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseJsonLoose(body.choices?.[0]?.message?.content ?? "");
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

