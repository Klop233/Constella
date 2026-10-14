import { config } from "./config.ts";
import type { Db } from "./db.ts";

/** Token usage statistics, built from per-request `usage` events (one per model request). */

export type UsageRange = "today" | "7d" | "30d";

interface UsageEvent {
  ts: string;
  runId: string;
  agentId: string;
  model: string;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  durationMs: number | null;
}

interface RunInfo {
  id: string;
  conversation_id: string;
  status: string;
  model: string;
  agent_id: string;
}

function localParts(iso: string, tz: string): { day: string; hour: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Start of the range as an ISO timestamp; "today" starts at local midnight in `tz`. */
export function rangeStart(range: UsageRange, now = new Date(), tz = config.timezone): string {
  if (range !== "today") return new Date(now.getTime() - (range === "7d" ? 7 : 30) * 86_400_000).toISOString();
  const { hour } = localParts(now.toISOString(), tz);
  const start = new Date(now.getTime() - hour * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  return start.toISOString();
}

/** Requests shorter than this are timing artifacts (e.g. reported mid-tool); they don't count toward speed. */
export const MIN_TIMED_MS = 250;
const tps = (output: number, ms: number) => (ms >= MIN_TIMED_MS && output > 0 ? output / (ms / 1000) : null);

export function usageStats(
  events: UsageEvent[],
  runs: Map<string, RunInfo>,
  range: UsageRange,
  now = new Date(),
  tz = config.timezone,
) {
  // Buckets: hours of today, or days of the range.
  const buckets = new Map<string, { label: string; tokens: number; requests: number }>();
  if (range === "today") {
    const { hour } = localParts(now.toISOString(), tz);
    for (let h = 0; h <= hour; h++) buckets.set(String(h), { label: `${String(h).padStart(2, "0")}:00`, tokens: 0, requests: 0 });
  } else {
    const days = range === "7d" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const day = localParts(new Date(now.getTime() - i * 86_400_000).toISOString(), tz).day;
      buckets.set(day, { label: day.slice(5).replace("-", "/"), tokens: 0, requests: 0 });
    }
  }

  const totals = { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
  const models = new Map<string, { requests: number; input: number; cached: number; output: number; timedOutput: number; timedMs: number; runs: Set<string> }>();
  const agents = new Map<string, { requests: number; input: number; cached: number; output: number }>();
  const runIds = new Set<string>();
  for (const e of events) {
    const { day, hour } = localParts(e.ts, tz);
    const b = buckets.get(range === "today" ? String(hour) : day);
    if (!b) continue;
    b.tokens += e.input + e.output;
    b.requests++;
    totals.requests++;
    totals.input += e.input;
    totals.cached += e.cached;
    totals.output += e.output;
    totals.reasoning += e.reasoning;
    runIds.add(e.runId);
    const m = models.get(e.model) ?? { requests: 0, input: 0, cached: 0, output: 0, timedOutput: 0, timedMs: 0, runs: new Set() };
    m.requests++;
    m.input += e.input;
    m.cached += e.cached;
    m.output += e.output;
    m.runs.add(e.runId);
    if (e.durationMs && e.durationMs >= MIN_TIMED_MS) {
      m.timedOutput += e.output;
      m.timedMs += e.durationMs;
    }
    models.set(e.model, m);
    const a = agents.get(e.agentId) ?? { requests: 0, input: 0, cached: 0, output: 0 };
    a.requests++;
    a.input += e.input;
    a.cached += e.cached;
    a.output += e.output;
    agents.set(e.agentId, a);
  }

  return {
    totals: { ...totals, runs: runIds.size, hitRate: totals.input ? totals.cached / totals.input : null },
    trend: [...buckets.values()],
    models: [...models]
      .map(([model, m]) => {
        const finished = [...m.runs].map((id) => runs.get(id)).filter((r) => r && ["done", "failed", "cancelled"].includes(r.status));
        return {
          model,
          requests: m.requests,
          runs: m.runs.size,
          input: m.input,
          cached: m.cached,
          output: m.output,
          successRate: finished.length ? finished.filter((r) => r!.status === "done").length / finished.length : null,
          tps: tps(m.timedOutput, m.timedMs),
          avgMs: m.timedMs && m.requests ? m.timedMs / m.requests : null,
        };
      })
      .sort((x, y) => y.requests - x.requests),
    agents: [...agents].map(([agentId, a]) => ({ agentId, ...a })).sort((x, y) => y.input + y.output - (x.input + x.output)),
    log: events
      .slice(-100)
      .reverse()
      .map((e) => ({
        ts: e.ts,
        agentId: e.agentId,
        model: e.model,
        input: e.input,
        cached: e.cached,
        output: e.output,
        durationMs: e.durationMs,
        tps: e.durationMs ? tps(e.output, e.durationMs) : null,
        conversationId: runs.get(e.runId)?.conversation_id ?? null,
        status: runs.get(e.runId)?.status ?? null,
      })),
  };
}

/**
 * Loads usage events since `since`, skipping replays (a resumed thread re-reports its last request with durationMs 0).
 * Each event's model becomes its run's model reference ("model@provider"), passed through `normalize`.
 */
export function loadUsage(
  db: Db,
  since: string,
  filter: { agentId?: string; model?: string },
  normalize: (ref: string) => string = (ref) => ref,
): { events: UsageEvent[]; runs: Map<string, RunInfo> } {
  const rows = db
    .prepare(`SELECT data FROM events WHERE type = 'usage' AND ts >= ? ${filter.agentId ? "AND agent_id = ?" : ""} ORDER BY ts`)
    .all(...([since, filter.agentId].filter(Boolean) as string[])) as { data: string }[];
  const events: UsageEvent[] = [];
  for (const { data } of rows) {
    const e = JSON.parse(data);
    if (e.durationMs === 0) continue;
    events.push({
      ts: e.ts,
      runId: e.runId,
      agentId: e.agentId,
      model: e.model,
      input: e.inputTokens ?? 0,
      cached: e.cachedInputTokens ?? 0,
      output: e.outputTokens ?? 0,
      reasoning: e.reasoningTokens ?? 0,
      durationMs: e.durationMs ?? null,
    });
  }
  const ids = [...new Set(events.map((e) => e.runId))];
  const runs = new Map<string, RunInfo>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rs = db.prepare(`SELECT id, conversation_id, status, model, agent_id FROM runs WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as unknown as RunInfo[];
    for (const r of rs) runs.set(r.id, r);
  }
  for (const e of events) e.model = normalize(runs.get(e.runId)?.model ?? e.model);
  return { events: filter.model ? events.filter((e) => e.model === filter.model) : events, runs };
}
