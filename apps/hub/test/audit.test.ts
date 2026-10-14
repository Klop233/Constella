import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-audit-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const { openDb, audit } = await import("../src/db.ts");
const { auditRefs, changesOf } = await import("../src/audit.ts");
const { requestSource } = await import("../src/request-source.ts");
const { describeDevice } = await import("../src/auth.ts");

function fixture() {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at)
     VALUES ('ag1', '助理', '✨', 'assistant', 'p', 'm', 'auto', '{"mode":"none"}', 'h', 'now', 'now')`,
  ).run();
  db.prepare("INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES ('cv1', 'ag1', '整理下载目录', 'now', 'now')").run();
  db.prepare(
    `INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, created_at) VALUES ('run1', 'cv1', 'ag1', '把下载目录按类型归档', 'done', 'gpt-x', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO approvals (id, run_id, agent_id, kind, summary, detail, status, created_at, resolved_at, source)
     VALUES ('ap1', 'run1', 'ag1', 'command', 'rm -rf ~/Downloads/tmp', NULL, 'approved', 'now', 'now', 'engine')`,
  ).run();
  return db;
}

const last = (db: ReturnType<typeof openDb>) => db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1").get() as { actor: string; action: string; detail: string | null };

describe("audit source", () => {
  it("adds the request's device and ip to entries written while handling a request", () => {
    const db = fixture();
    requestSource.run({ ip: "100.64.0.9", device: "Windows · Edge" }, () => audit(db, "us_1", "settings.update", { fields: ["defaultModel"] }));
    expect(JSON.parse(last(db).detail!)).toEqual({ fields: ["defaultModel"], via: { ip: "100.64.0.9", device: "Windows · Edge" } });
  });

  it("also records the source of an action that has no detail of its own", () => {
    const db = fixture();
    requestSource.run({ ip: "1.2.3.4", device: "Android · Chrome" }, () => audit(db, "us_1", "run.interrupt"));
    expect(JSON.parse(last(db).detail!)).toEqual({ via: { ip: "1.2.3.4", device: "Android · Chrome" } });
  });

  it("leaves entries made by the system outside any request without a source", () => {
    const db = fixture();
    audit(db, "system", "run.auto_resume", { runId: "run1" });
    audit(db, "supervisor", "supervisor.wait");
    expect(db.prepare("SELECT detail FROM audit ORDER BY id").all()).toEqual([{ detail: '{"runId":"run1"}' }, { detail: null }]);
  });

  it("names the device from the user agent", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120")).toBe("Windows · Edge");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")).toBe("Android · Chrome");
  });
});

describe("audit source through fastify", () => {
  it("reaches audit() from an async handler, and does not leak between concurrent requests", async () => {
    const db = fixture();
    const app = Fastify();
    // Same registration as routes.ts: a callback-style hook that runs the rest of the request inside the store.
    app.addHook("onRequest", (req, _reply, done) => {
      if (!req.url.startsWith("/api/") || req.url.startsWith("/api/runner")) return done();
      requestSource.run({ ip: req.ip, device: describeDevice(String(req.headers["user-agent"] ?? "")) }, done);
    });
    app.addHook("onRequest", async () => {});
    app.post("/api/do/:n", async (req) => {
      const n = (req.params as { n: string }).n;
      await new Promise((r) => setTimeout(r, n === "1" ? 20 : 1));
      audit(db, "us_1", `test.${n}`);
      return { ok: true };
    });
    app.post("/api/runner/x", async () => {
      audit(db, "agent:ag1", "test.runner");
      return { ok: true };
    });
    await Promise.all([
      app.inject({ method: "POST", url: "/api/do/1", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120" }, remoteAddress: "10.0.0.1" }),
      app.inject({ method: "POST", url: "/api/do/2", headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120" }, remoteAddress: "10.0.0.2" }),
    ]);
    await app.inject({ method: "POST", url: "/api/runner/x", remoteAddress: "172.18.0.5" });
    const by = (action: string) => JSON.parse((db.prepare("SELECT detail FROM audit WHERE action = ?").get(action) as { detail: string | null }).detail ?? "null");
    expect(by("test.1")).toEqual({ via: { ip: "10.0.0.1", device: "Windows · Chrome" } });
    expect(by("test.2")).toEqual({ via: { ip: "10.0.0.2", device: "Android · Chrome" } });
    expect(by("test.runner")).toBeNull();
    await app.close();
  });
});

describe("auditRefs", () => {
  it("resolves an approval to its command, the task it belonged to, and the agent", () => {
    const db = fixture();
    const refs = auditRefs(db, { action: "approval.approve", detail: JSON.stringify({ approvalId: "ap1" }) });
    expect(refs.approval).toMatchObject({ id: "ap1", kind: "command", summary: "rm -rf ~/Downloads/tmp", status: "approved" });
    expect(refs.run).toMatchObject({ id: "run1", prompt: "把下载目录按类型归档", model: "gpt-x" });
    expect(refs.conversation).toEqual({ id: "cv1", title: "整理下载目录" });
    expect(refs.agent).toMatchObject({ id: "ag1", name: "助理", emoji: "✨", archived: false });
  });

  it("uses `id` as the object an agent / schedule / desktop entry is about", () => {
    const db = fixture();
    db.prepare("INSERT INTO schedules (id, name, cron, tz, kind, agent_id, payload, enabled, created_at) VALUES ('sc1', '吃药提醒', '0 8 * * *', 'UTC', 'agent_prompt', 'ag1', '{}', 1, 'now')").run();
    db.prepare("INSERT INTO desktops (id, name, lease, created_at, last_used_at) VALUES ('dk1', '办公桌面', '{}', 'now', 'now')").run();
    expect(auditRefs(db, { action: "agent.update", detail: '{"id":"ag1"}' }).agent?.name).toBe("助理");
    expect(auditRefs(db, { action: "schedule.update", detail: '{"id":"sc1"}' }).schedule).toEqual({ id: "sc1", name: "吃药提醒", cron: "0 8 * * *", enabled: true });
    expect(auditRefs(db, { action: "desktop.takeover", detail: '{"id":"dk1"}' }).desktop).toEqual({ id: "dk1", name: "办公桌面" });
    // The same id means nothing to an entry that is about something else.
    expect(auditRefs(db, { action: "provider.update", detail: '{"id":"ag1"}' })).toEqual({});
  });

  it("returns nothing for objects that are gone, and survives bad detail", () => {
    const db = fixture();
    expect(auditRefs(db, { action: "approval.deny", detail: '{"approvalId":"nope"}' })).toEqual({});
    expect(auditRefs(db, { action: "desktop.delete", detail: '{"id":"dk-gone","name":"旧桌面"}' })).toEqual({});
    expect(auditRefs(db, { action: "auth.login", detail: "not json" })).toEqual({});
    expect(auditRefs(db, { action: "auth.login", detail: null })).toEqual({});
  });

  it("cuts a long task prompt", () => {
    const db = fixture();
    db.prepare("UPDATE runs SET prompt = ? WHERE id = 'run1'").run("长".repeat(1000));
    const refs = auditRefs(db, { action: "run.interrupt", detail: '{"runId":"run1"}' });
    expect(refs.run!.prompt.length).toBe(301);
    expect(refs.run!.prompt.endsWith("…")).toBe(true);
  });
});

describe("changesOf", () => {
  it("keeps only the fields that changed, with before and after", () => {
    const before = { defaultModel: "a", autoResume: true, backupKeep: 7 };
    const after = { defaultModel: "b", autoResume: true, backupKeep: 7 };
    expect(changesOf(before, after, ["defaultModel", "autoResume"])).toEqual({ defaultModel: { from: "a", to: "b" } });
  });

  it("compares nested objects key by key", () => {
    const before = { notifyOn: { approval: true, done: false } };
    const after = { notifyOn: { approval: true, done: true } };
    expect(changesOf(before, after, ["notifyOn"])).toEqual({ "notifyOn.done": { from: false, to: true } });
  });

  it("treats a missing value as null and cuts long text", () => {
    const out = changesOf({ effort: undefined, persona: "旧" }, { effort: "high", persona: "新".repeat(400) }, ["effort", "persona"]);
    expect(out.effort).toEqual({ from: null, to: "high" });
    expect((out.persona!.to as string).length).toBe(301);
  });

  it("reports nothing when the save changed nothing", () => {
    expect(changesOf({ model: "m" }, { model: "m" }, ["model"])).toEqual({});
  });
});
