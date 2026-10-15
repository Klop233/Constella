import { redact } from "./secrets.ts";
import { EventEmitter } from "node:events";
import type { AgentEvent, RunnerEvent } from "@constella/protocol";
import { newId, nowIso } from "./config.ts";
import type { Db } from "./db.ts";

/** Messages on the global activity stream (SSE). `cursor` is the events rowid for agent events. */
export type HubMessage =
  | { kind: "event"; cursor: number; conversationId: string; event: AgentEvent }
  | { kind: "hub"; type: string; data: unknown };

/**
 * Append-only event log. Every agent event gets a per-run `seq` and a global cursor (rowid),
 * which the PWA passes back as Last-Event-ID to resume after a network drop.
 */
export class EventStore {
  readonly bus = new EventEmitter();
  #db: Db;
  #seq = new Map<string, number>();

  constructor(db: Db) {
    this.#db = db;
    this.bus.setMaxListeners(0);
  }

  secretValues: () => Iterable<string> = () => [];

  /** Redact values, never JSON syntax or routing identity fields. */
  sanitize<T>(value: T): T {
    const values = [...this.secretValues()].filter(Boolean).sort((a,b) => b.length-a.length);
    const visit = (v: unknown, key = ""): unknown => {
      if (typeof v === "string") return /^(id|.*Id|type|status|ts|kind)$/.test(key) ? v : redact(v, values);
      if (Array.isArray(v)) return v.map(x => visit(x));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,visit(x,k)]));
      return v;
    };
    return visit(value) as T;
  }

  append(agentId: string, conversationId: string, ev: RunnerEvent): AgentEvent {
    ev = this.sanitize(ev);
    const seq = this.#nextSeq(ev.runId);
    const event = { ...ev, id: newId("ev"), agentId, seq, ts: nowIso() } as AgentEvent;
    const { id, runId, type, ts } = event;
    const info = this.#db
      .prepare("INSERT INTO events (run_id, seq, id, agent_id, type, ts, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, seq, id, agentId, type, ts, JSON.stringify(event));
    const cursor = Number(info.lastInsertRowid);
    this.bus.emit("message", { kind: "event", cursor, conversationId, event } satisfies HubMessage);
    return event;
  }

  /** Non-persisted hub notifications (agent/desktop status, learning, schedules). */
  publish(type: string, data: unknown): void {
    this.bus.emit("message", { kind: "hub", type, data } satisfies HubMessage);
  }

  forRun(runId: string): AgentEvent[] {
    return (this.#db.prepare("SELECT data FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }

  /** Events after a global cursor, for SSE resume. */
  since(cursor: number, limit = 2000): { cursor: number; conversationId: string; event: AgentEvent }[] {
    const rows = this.#db
      .prepare(
        `SELECT e.rowid AS cursor, e.data, r.conversation_id FROM events e JOIN runs r ON r.id = e.run_id
         WHERE e.rowid > ? ORDER BY e.rowid LIMIT ?`,
      )
      .all(cursor, limit) as { cursor: number; data: string; conversation_id: string }[];
    return rows.map((r) => ({ cursor: r.cursor, conversationId: r.conversation_id, event: JSON.parse(r.data) }));
  }

  latestCursor(): number {
    return (this.#db.prepare("SELECT COALESCE(MAX(rowid), 0) AS c FROM events").get() as { c: number }).c;
  }

  #nextSeq(runId: string): number {
    let seq = this.#seq.get(runId);
    if (seq === undefined) {
      const row = this.#db.prepare("SELECT COALESCE(MAX(seq), -1) AS s FROM events WHERE run_id = ?").get(runId) as { s: number };
      seq = row.s;
    }
    seq += 1;
    this.#seq.set(runId, seq);
    return seq;
  }

  forget(runId: string): void {
    this.#seq.delete(runId);
  }
}
