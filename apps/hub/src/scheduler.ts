import { Cron } from "croner";
import { z } from "zod";
import { changesOf } from "./audit.ts";
import { config, newId, nowIso } from "./config.ts";
import { audit, type Db } from "./db.ts";
import type { EventStore } from "./events.ts";

export interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  tz: string;
  kind: "notify" | "agent_prompt" | "system";
  agent_id: string | null;
  payload: string;
  enabled: number;
  created_at: string;
}

export const ScheduleInput = z.object({
  name: z.string().trim().min(1).max(60),
  cron: z.string().trim().min(9).max(60),
  tz: z.string().default(config.timezone),
  kind: z.enum(["notify", "agent_prompt"]),
  agentId: z.string().nullable().optional(),
  payload: z.union([
    z.object({ title: z.string().max(80), body: z.string().max(500) }),
    z.object({ text: z.string().min(1).max(4000) }),
  ]),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.input<typeof ScheduleInput>;

export type ScheduleHandler = (s: ScheduleRow) => Promise<{ ok: boolean; detail?: string; runId?: string }>;

/** Cron jobs persisted in SQLite; every firing is recorded for the app's history view. */
export class Scheduler {
  #db: Db;
  #events: EventStore;
  #jobs = new Map<string, Cron>();
  #handlers: Record<string, ScheduleHandler> = {};

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  on(kind: string, handler: ScheduleHandler): void {
    this.#handlers[kind] = handler;
  }

  list(): ScheduleRow[] {
    return this.#db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as unknown as ScheduleRow[];
  }

  get(id: string): ScheduleRow {
    const r = this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    if (!r) throw new Error("schedule not found");
    return r;
  }

  create(input: ScheduleInput, actor: string): ScheduleRow {
    const s = ScheduleInput.parse(input);
    validateCron(s.cron, s.tz);
    if (s.kind === "agent_prompt" && !s.agentId) throw new Error("agent 任务需要指定 agent");
    const id = newId("sc");
    this.#db
      .prepare("INSERT INTO schedules (id, name, cron, tz, kind, agent_id, payload, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, s.name, s.cron, s.tz, s.kind, s.agentId ?? null, JSON.stringify(s.payload), s.enabled ? 1 : 0, nowIso());
    audit(this.#db, actor, "schedule.create", { id, name: s.name, cron: s.cron });
    this.#arm(this.get(id));
    this.#events.publish("schedule", { id });
    return this.get(id);
  }

  /** Internal jobs (curation, backups); kept in the table so they show up in history. */
  ensureSystem(id: string, name: string, cron: string): void {
    if (!this.#db.prepare("SELECT 1 FROM schedules WHERE id = ?").get(id)) {
      this.#db
        .prepare("INSERT INTO schedules (id, name, cron, tz, kind, agent_id, payload, enabled, created_at) VALUES (?, ?, ?, ?, 'system', NULL, '{}', 1, ?)")
        .run(id, name, cron, config.timezone, nowIso());
    }
  }

  update(id: string, patch: Partial<ScheduleInput>, actor: string): ScheduleRow {
    const cur = this.get(id);
    if (cur.kind === "system" && (patch.cron || patch.payload || patch.kind)) throw new Error("系统任务只能启用或停用");
    const merged = {
      name: patch.name ?? cur.name,
      cron: patch.cron ?? cur.cron,
      tz: patch.tz ?? cur.tz,
      enabled: patch.enabled ?? !!cur.enabled,
      payload: patch.payload ?? JSON.parse(cur.payload),
    };
    validateCron(merged.cron, merged.tz);
    this.#db
      .prepare("UPDATE schedules SET name = ?, cron = ?, tz = ?, enabled = ?, payload = ? WHERE id = ?")
      .run(merged.name, merged.cron, merged.tz, merged.enabled ? 1 : 0, JSON.stringify(merged.payload), id);
    audit(this.#db, actor, "schedule.update", {
      id,
      name: merged.name,
      changes: changesOf({ name: cur.name, cron: cur.cron, tz: cur.tz, enabled: !!cur.enabled, payload: JSON.parse(cur.payload) }, merged, ["name", "cron", "tz", "enabled", "payload"]),
    });
    this.#arm(this.get(id));
    this.#events.publish("schedule", { id });
    return this.get(id);
  }

  remove(id: string, actor: string): void {
    const cur = this.get(id);
    if (cur.kind === "system") throw new Error("系统任务不能删除");
    this.#jobs.get(id)?.stop();
    this.#jobs.delete(id);
    this.#db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    audit(this.#db, actor, "schedule.delete", { id, name: cur.name, cron: cur.cron });
    this.#events.publish("schedule", { id, removed: true });
  }

  nextRun(id: string): string | null {
    return this.#jobs.get(id)?.nextRun()?.toISOString() ?? null;
  }

  history(id: string, limit = 50): unknown[] {
    return this.#db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY fired_at DESC LIMIT ?").all(id, limit);
  }

  start(): void {
    for (const s of this.list()) this.#arm(s);
  }

  stop(): void {
    for (const j of this.#jobs.values()) j.stop();
    this.#jobs.clear();
  }

  async fire(id: string): Promise<{ ok: boolean; detail?: string }> {
    const s = this.get(id);
    const handler = this.#handlers[s.kind === "system" ? s.id : s.kind];
    let result: { ok: boolean; detail?: string; runId?: string };
    try {
      result = handler ? await handler(s) : { ok: false, detail: "no handler" };
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    this.#db
      .prepare("INSERT INTO schedule_runs (id, schedule_id, fired_at, ok, detail, run_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("sr"), id, nowIso(), result.ok ? 1 : 0, result.detail ?? null, result.runId ?? null);
    this.#events.publish("schedule.fired", { id, ok: result.ok });
    return result;
  }

  #arm(s: ScheduleRow): void {
    this.#jobs.get(s.id)?.stop();
    this.#jobs.delete(s.id);
    if (!s.enabled) return;
    const job = new Cron(s.cron, { timezone: s.tz, protect: true }, () => void this.fire(s.id));
    this.#jobs.set(s.id, job);
  }
}

function validateCron(expr: string, tz: string): void {
  try {
    const c = new Cron(expr, { timezone: tz, paused: true });
    if (!c.nextRun()) throw new Error("never fires");
    c.stop();
  } catch (err) {
    throw new Error(`cron 表达式无效：${expr}（${err instanceof Error ? err.message : err}）`);
  }
}
