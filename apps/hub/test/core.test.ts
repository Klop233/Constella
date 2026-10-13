import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canTransition } from "@constella/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-test-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const { openDb } = await import("../src/db.ts");
const { EventStore } = await import("../src/events.ts");
const { Knowledge } = await import("../src/knowledge.ts");
const { RunManager } = await import("../src/runs.ts");
const { RfbClientFilter } = await import("../src/desktops.ts");
const { SecretBox, redact } = await import("../src/secrets.ts");
const { hashPassword, verifyPassword } = await import("../src/auth.ts");
const { transcriptFor } = await import("../src/learning.ts");
const { parseJsonLoose } = await import("../src/newapi.ts");

describe("run state machine", () => {
  it("allows the normal lifecycle and rejects leaving terminal states", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_approval", "running")).toBe(true);
    expect(canTransition("paused_by_user", "done")).toBe(true);
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("cancelled", "failed")).toBe(false);
  });
});

describe("RunManager", () => {
  let db: ReturnType<typeof openDb>;
  let sent: any[];
  let notes: string[];
  let runs: InstanceType<typeof RunManager>;

  beforeEach(() => {
    db = openDb(":memory:");
    db.prepare(
      `INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at)
       VALUES ('ag1', '助理', '✨', 'assistant', 'p', 'm', 'auto', '{"mode":"none"}', 'h', 'now', 'now')`,
    ).run();
    sent = [];
    notes = [];
    runs = new RunManager({
      db,
      events: new EventStore(db),
      ensureRunner: async () => {},
      sendToRunner: (_a, msg) => {
        sent.push(msg);
        return true;
      },
      startPayload: () => ({ model: "m", instructions: "i", approvalPolicy: "auto", skillRoots: [] }),
      notify: (t) => notes.push(t),
    });
  });

  it("starts a run, steers while running, and finishes", async () => {
    const r = await runs.send({ agentId: "ag1", text: "你好" });
    await new Promise((res) => setTimeout(res, 10));
    expect(runs.get(r.runId)!.status).toBe("running");
    expect(sent[0]).toMatchObject({ t: "start", runId: r.runId, text: "你好" });
    const s = await runs.send({ agentId: "ag1", conversationId: r.conversationId, text: "补充" });
    expect(s.steered).toBe(true);
    expect(sent[1]).toMatchObject({ t: "steer", runId: r.runId });
    runs.onRunnerEvent("ag1", { type: "tool.started", runId: r.runId, callId: "c1", name: "shell", input: {} });
    runs.onRunnerEvent("ag1", { type: "usage", runId: r.runId, model: "m", inputTokens: 10, outputTokens: 5 });
    runs.finish(r.runId, "done");
    const done = runs.get(r.runId)!;
    expect(done).toMatchObject({ status: "done", tool_calls: 1, input_tokens: 10, output_tokens: 5 });
  });

  it("uses the conversation's model / effort override and remembers it", async () => {
    const r = await runs.send({ agentId: "ag1", text: "a", model: "m2", effort: "high" });
    await new Promise((res) => setTimeout(res, 10));
    expect(sent[0]).toMatchObject({ t: "start", model: "m2", effort: "high" });
    expect(runs.get(r.runId)!.model).toBe("m2");
    runs.finish(r.runId, "done");
    const r2 = await runs.send({ agentId: "ag1", conversationId: r.conversationId, text: "b" });
    await new Promise((res) => setTimeout(res, 10));
    expect(sent[1]).toMatchObject({ t: "start", model: "m2", effort: "high" });
    runs.finish(r2.runId, "done");
    runs.setConversationModel(r.conversationId, { model: null, effort: null });
    await runs.send({ agentId: "ag1", conversationId: r.conversationId, text: "c" });
    await new Promise((res) => setTimeout(res, 10));
    expect(sent[2].model).toBe("m");
    expect(sent[2].effort).toBeUndefined();
  });

  it("routes engine approvals to the runner and resumes", async () => {
    const r = await runs.send({ agentId: "ag1", text: "删除文件" });
    await new Promise((res) => setTimeout(res, 10));
    runs.onRunnerEvent("ag1", { type: "approval.requested", runId: r.runId, approvalId: "ap1", kind: "command", summary: "rm x" });
    expect(runs.get(r.runId)!.status).toBe("waiting_approval");
    expect(notes.some((n) => n.includes("请求审批"))).toBe(true);
    await runs.resolveApproval("ap1", "approve", "user");
    expect(sent.at(-1)).toMatchObject({ t: "approval_decision", approvalId: "ap1", decision: "approve" });
    expect(runs.get(r.runId)!.status).toBe("running");
    await expect(runs.resolveApproval("ap1", "deny", "user")).rejects.toThrow();
  });

  it("resolves hub-side approvals and fails runs a reconnecting runner forgot", async () => {
    const r = await runs.send({ agentId: "ag1", text: "x" });
    await new Promise((res) => setTimeout(res, 10));
    const pending = runs.requestHubApproval(r.runId, "host_access", "reboot");
    const ap = db.prepare("SELECT id FROM approvals WHERE run_id = ?").get(r.runId) as { id: string };
    await runs.resolveApproval(ap.id, "deny", "user");
    await expect(pending).resolves.toBe(false);
    runs.onRunnerHello("ag1", []);
    expect(runs.get(r.runId)!.status).toBe("failed");
  });
});

describe("Knowledge", () => {
  let db: ReturnType<typeof openDb>;
  let k: InstanceType<typeof Knowledge>;

  beforeEach(() => {
    fs.rmSync(path.join(tmp, "agents"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, "shared"), { recursive: true, force: true });
    db = openDb(":memory:");
    k = new Knowledge(db, new EventStore(db), () => ["supersecretvalue"]);
    k.ensureShared();
    k.ensureAgent("ag1");
  });

  it("adds, dedupes, updates and deletes memory with one commit each", () => {
    const evs = k.apply("ag1", { memory: [{ op: "add", text: "用户喜欢简洁的回答" }, { op: "add", text: "用户喜欢简洁的回答。" }] }, { runId: null, reason: "t" });
    expect(evs).toHaveLength(1);
    k.apply("ag1", { memory: [{ op: "update", match: "简洁", text: "用户喜欢非常简洁的回答" }] }, { runId: null, reason: "t" });
    expect(k.memory("ag1").agent).toContain("非常简洁");
    k.apply("ag1", { memory: [{ op: "delete", match: "非常简洁" }] }, { runId: null, reason: "t" });
    expect(k.memory("ag1").agent).not.toContain("简洁");
  });

  it("writes skills, redacts secrets and reverts a learning step", () => {
    const [ev] = k.apply(
      "ag1",
      { skills: [{ op: "create", name: "deploy-site", description: "部署静态站点", body: "1. 构建\n2. 使用密钥 supersecretvalue 上传\n3. 验证" }] },
      { runId: null, reason: "t" },
    );
    const body = k.skillBody("ag1", "deploy-site");
    expect(body).toContain("name: deploy-site");
    expect(body).not.toContain("supersecretvalue");
    expect(k.skills("ag1").map((s) => s.name)).toContain("deploy-site");
    expect(k.diff(ev!.id)).toContain("deploy-site");
    k.revert(ev!.id, "user");
    expect(() => k.skillBody("ag1", "deploy-site")).toThrow();
  });

  it("rejects invalid skill names", () => {
    expect(() => k.apply("ag1", { skills: [{ op: "create", name: "../evil", description: "xxxxx", body: "x".repeat(30) }] }, { runId: null, reason: "t" })).toThrow();
  });
});

describe("RFB client filter", () => {
  const handshake = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1]), Buffer.from([1])]);
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
  const pointer = Buffer.from([5, 0, 0, 10, 0, 10]);
  const fbreq = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);

  it("drops input while view-only and passes it when allowed", () => {
    let allow = false;
    const f = new RfbClientFilter(() => allow);
    expect(f.push(handshake)).toEqual(handshake);
    expect(f.push(Buffer.concat([key, pointer, fbreq]))).toEqual(fbreq);
    allow = true;
    expect(f.push(Buffer.concat([key, pointer]))).toEqual(Buffer.concat([key, pointer]));
  });

  it("handles messages split across chunks and rejects unknown types", () => {
    const f = new RfbClientFilter(() => true);
    f.push(handshake);
    expect(f.push(fbreq.subarray(0, 4))).toEqual(Buffer.alloc(0));
    expect(f.push(fbreq.subarray(4))).toEqual(fbreq);
    expect(f.push(Buffer.from([99]))).toBeNull();
  });
});

describe("helpers", () => {
  it("seals and opens secrets", () => {
    const box = new SecretBox(Buffer.alloc(32, 1).toString("base64"));
    const sealed = box.seal("sk-123");
    expect(sealed).not.toContain("sk-123");
    expect(box.open(sealed)).toBe("sk-123");
    expect(redact("token=abcdef123", ["abcdef123"])).toBe("token=«secret»");
  });

  it("hashes passwords", () => {
    const h = hashPassword("correct horse");
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("parses fenced JSON and summarizes transcripts", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    const t = transcriptFor({ prompt: "查天气", status: "done", error: null }, [
      { type: "tool.started", runId: "r", callId: "c", name: "shell", input: { command: "curl wttr.in" }, id: "e", agentId: "a", seq: 0, ts: "t" },
      { type: "tool.completed", runId: "r", callId: "c", ok: true, id: "e2", agentId: "a", seq: 1, ts: "t" },
      { type: "message.completed", runId: "r", messageId: "m", text: "晴", id: "e3", agentId: "a", seq: 2, ts: "t" },
    ] as any);
    expect(t).toContain("curl wttr.in");
    expect(t).toContain("助手：晴");
  });
});

afterEach(() => {});
