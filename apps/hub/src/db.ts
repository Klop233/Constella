import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT NOT NULL,
    totp_secret TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
    transports TEXT, rp_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device TEXT NOT NULL, ip TEXT,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, name));
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL, template TEXT NOT NULL,
    persona TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, approval_policy TEXT NOT NULL,
    desktop_policy TEXT NOT NULL, host_access INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT NOT NULL, newapi_token_id INTEGER, budget_daily_usd REAL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, thread_id TEXT,
    source TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX conversations_agent ON conversations(agent_id, updated_at);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, feedback INTEGER,
    reflected INTEGER NOT NULL DEFAULT 0, last_event_at TEXT, created_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE INDEX runs_conversation ON runs(conversation_id, created_at);
  CREATE INDEX runs_status ON runs(status);
  CREATE TABLE events (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, agent_id TEXT NOT NULL,
    type TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
    detail TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, source TEXT NOT NULL DEFAULT 'engine'
  );
  CREATE TABLE desktops (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, lease TEXT NOT NULL, pinned_agent_id TEXT,
    created_at TEXT NOT NULL, last_used_at TEXT NOT NULL
  );
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, tz TEXT NOT NULL, kind TEXT NOT NULL,
    agent_id TEXT, payload TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, fired_at TEXT NOT NULL, ok INTEGER NOT NULL,
    detail TEXT, run_id TEXT
  );
  CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id, fired_at);
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, device TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE learning_events (
    id TEXT PRIMARY KEY, agent_id TEXT, scope TEXT NOT NULL, kind TEXT NOT NULL, op TEXT NOT NULL,
    target TEXT NOT NULL, summary TEXT NOT NULL, commit_sha TEXT NOT NULL, run_id TEXT,
    reverted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE skill_usage (agent_id TEXT NOT NULL, skill TEXT NOT NULL, uses INTEGER NOT NULL, last_used_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, skill));
  CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0
  );
  `,
  // Per-conversation model / reasoning effort; NULL falls back to the agent's.
  `
  ALTER TABLE conversations ADD COLUMN model TEXT;
  ALTER TABLE conversations ADD COLUMN effort TEXT;
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function kvGet(db: Db, key: string): string | undefined {
  return (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function audit(db: Db, actor: string, action: string, detail?: unknown): void {
  db.prepare("INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)").run(
    new Date().toISOString(),
    actor,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
