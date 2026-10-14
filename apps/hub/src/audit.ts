import type { Db } from "./db.ts";

/** What an audit entry's ids point at today, resolved when the entry is opened. Missing = the object no longer exists. */
export interface AuditRefs {
  agent?: { id: string; name: string; emoji: string; archived: boolean };
  approval?: {
    id: string;
    kind: string;
    summary: string;
    detail: string | null;
    status: string;
    source: string;
    created_at: string;
    resolved_at: string | null;
    answer: string | null;
  };
  run?: { id: string; status: string; model: string; prompt: string; error: string | null; created_at: string; finished_at: string | null };
  conversation?: { id: string; title: string };
  desktop?: { id: string; name: string };
  schedule?: { id: string; name: string; cron: string; enabled: boolean };
  incident?: { id: string; title: string; kind: string; status: string };
  artifact?: { id: string; title: string; filename: string; version: number };
}

const PROMPT_MAX = 300;
const VALUE_MAX = 300;

function parseDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const d = JSON.parse(detail);
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Looks up the agent / approval / run / … an entry's detail mentions, so the entry can show names instead of ids. */
export function auditRefs(db: Db, row: { action: string; detail: string | null }): AuditRefs {
  const d = parseDetail(row.detail);
  const str = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : undefined);
  const kind = row.action.split(".")[0];
  const one = <T>(sql: string, id: string | undefined): T | undefined => (id ? (db.prepare(sql).get(id) as T | undefined) : undefined);
  const refs: AuditRefs = {};

  const approval = one<NonNullable<AuditRefs["approval"]> & { run_id: string; agent_id: string }>(
    "SELECT id, run_id, agent_id, kind, summary, detail, status, source, created_at, resolved_at, answer FROM approvals WHERE id = ?",
    str("approvalId"),
  );
  if (approval) {
    const { run_id: _r, agent_id: _a, ...shown } = approval;
    refs.approval = shown;
  }

  const run = one<NonNullable<AuditRefs["run"]> & { conversation_id: string; agent_id: string }>(
    "SELECT id, conversation_id, agent_id, status, model, prompt, error, created_at, finished_at FROM runs WHERE id = ?",
    str("runId") ?? approval?.run_id,
  );
  if (run) {
    const { conversation_id: _c, agent_id: _a, ...shown } = run;
    refs.run = { ...shown, prompt: shown.prompt.length > PROMPT_MAX ? `${shown.prompt.slice(0, PROMPT_MAX)}…` : shown.prompt };
  }

  const conversation = one<NonNullable<AuditRefs["conversation"]>>(
    "SELECT id, title FROM conversations WHERE id = ?",
    str("conversationId") ?? run?.conversation_id,
  );
  if (conversation) refs.conversation = conversation;

  const schedule = kind === "schedule" ? one<{ id: string; name: string; cron: string; enabled: number }>("SELECT id, name, cron, enabled FROM schedules WHERE id = ?", str("id")) : undefined;
  if (schedule) refs.schedule = { ...schedule, enabled: !!schedule.enabled };

  const artifact = kind === "artifact" ? one<NonNullable<AuditRefs["artifact"]> & { agent_id: string }>("SELECT id, agent_id, title, filename, version FROM artifacts WHERE id = ?", str("id")) : undefined;
  if (artifact) {
    const { agent_id: _a, ...shown } = artifact;
    refs.artifact = shown;
  }

  const agentId = str("agentId") ?? (kind === "agent" ? str("id") : undefined) ?? approval?.agent_id ?? run?.agent_id ?? artifact?.agent_id;
  const agent = one<{ id: string; name: string; emoji: string; archived: number }>("SELECT id, name, emoji, archived FROM agents WHERE id = ?", agentId);
  if (agent) refs.agent = { ...agent, archived: !!agent.archived };

  const desktop = kind === "desktop" ? one<NonNullable<AuditRefs["desktop"]>>("SELECT id, name FROM desktops WHERE id = ?", str("id")) : undefined;
  if (desktop) refs.desktop = desktop;

  const incident = kind === "incident" ? one<NonNullable<AuditRefs["incident"]>>("SELECT id, title, kind, status FROM incidents WHERE id = ?", str("id")) : undefined;
  if (incident) refs.incident = incident;

  return refs;
}

export type Change = { from: unknown; to: unknown };

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shorten(v: unknown): unknown {
  if (v === undefined) return null;
  return typeof v === "string" && v.length > VALUE_MAX ? `${v.slice(0, VALUE_MAX)}…` : v;
}

/**
 * Before/after values of `keys` that actually changed. Nested objects are compared key by key (`notifyOn.approval`);
 * long text is cut so one persona rewrite doesn't bloat the log.
 */
export function changesOf(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): Record<string, Change> {
  const out: Record<string, Change> = {};
  const walk = (key: string, a: unknown, b: unknown) => {
    if (isPlain(a) && isPlain(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(`${key}.${k}`, a[k], b[k]);
      return;
    }
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return;
    out[key] = { from: shorten(a), to: shorten(b) };
  };
  for (const k of keys) walk(k, before[k], after[k]);
  return out;
}
