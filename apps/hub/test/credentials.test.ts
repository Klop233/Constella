import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-cred-"));
process.env.CONSTELLA_DATA_DIR = tmp;

const { openDb } = await import("../src/db.ts");
const { EventStore } = await import("../src/events.ts");
const { SecretBox, SecretStore, redact } = await import("../src/secrets.ts");
const { Credentials } = await import("../src/credentials.ts");
type Db = ReturnType<typeof openDb>;
type Provider = import("../src/credential-provider.ts").CredentialProvider;

const KEY = Buffer.alloc(32, 7).toString("base64");

function addAgent(db: Db, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at)
     VALUES (?, ?, '✨', 'assistant', 'p', 'm', 'auto', '{}', ?, 'now', 'now')`,
  ).run(id, id, `h-${id}`);
}

/** Stand-in vault: no CLI, no network. */
class FakeProvider implements Provider {
  values: Record<string, string> = { "login.username": "me", "login.password": "hunter2", "login.totp": "123456" };
  reads = 0;
  #open = new Set<string>();
  unlocked(id: string): boolean {
    return this.#open.has(id);
  }
  async unlock(c: { id: string }): Promise<void> {
    this.#open.add(c.id);
  }
  lock(id: string): void {
    this.#open.delete(id);
  }
  async sync(): Promise<void> {}
  async items() {
    return [{ id: "item-1", name: "GitHub", username: "me", uris: ["https://github.com"], fields: ["login.username", "login.password", "login.totp"] }];
  }
  async read(_c: unknown, _itemId: string, fields: string[]): Promise<Record<string, string>> {
    this.reads += 1;
    const out: Record<string, string> = {};
    for (const f of fields) out[f] = this.values[f]!;
    return out;
  }
}

/** Stand-in RunManager: runs live in a map, `finish` fires the hooks the hub registers. */
class FakeRuns {
  rows = new Map<string, { id: string; agent_id: string; status: string }>();
  sent: { agentId: string; source?: string; text: string }[] = [];
  #hooks: ((run: { id: string; agent_id: string; status: string }) => void)[] = [];
  get(id: string) {
    return this.rows.get(id);
  }
  onFinished(hook: (run: { id: string; agent_id: string; status: string }) => void): void {
    this.#hooks.push(hook);
  }
  async send(input: { agentId: string; source?: string; text: string }): Promise<{ runId: string }> {
    this.sent.push(input);
    const runId = `review-${this.sent.length}`;
    this.rows.set(runId, { id: runId, agent_id: input.agentId, status: "running" });
    return { runId };
  }
  finish(id: string): void {
    const run = this.rows.get(id);
    if (!run) throw new Error(`no run ${id}`);
    run.status = "done";
    for (const hook of this.#hooks) hook(run);
  }
}

const live: Credentials[] = [];
function setup() {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const secrets = new SecretStore(db, new SecretBox(KEY));
  const runs = new FakeRuns();
  const provider = new FakeProvider();
  const credentials = new Credentials({ db, secrets, events, runs: runs as never, provider });
  events.secretValues = () => credentials.secretValues();
  live.push(credentials);
  addAgent(db, "a");
  addAgent(db, "reviewer");
  runs.rows.set("run-a", { id: "run-a", agent_id: "a", status: "running" });
  return { db, events, secrets, runs, provider, credentials };
}

/** Create + unlock a connection, and make the request that the tests then approve or attack. */
async function withRequest(over: { approver?: string | null } = {}) {
  const s = setup();
  s.credentials.setApprover(over.approver === undefined ? "reviewer" : over.approver, "owner");
  const conn = s.credentials.create(
    { name: "家用", provider: "bitwarden", server: "us", clientId: "user.abc", clientSecret: "secret-xyz" },
    "owner",
  );
  await s.credentials.unlock(conn.id, "master-password", "owner");
  const req = await s.credentials.request("a", "run-a", {
    connectionId: conn.id,
    itemId: "item-1",
    fields: ["login.password"],
    purpose: "登录 GitHub 查 issue",
    target: "https://github.com",
  });
  return { ...s, conn, req };
}

/** Let the fire-and-forget review scheduling run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  while (live.length) live.pop()!.close();
});

describe("credential requests", () => {
  it("needs a live run and an unlocked vault", async () => {
    const s = setup();
    const conn = s.credentials.create(
      { name: "家用", provider: "bitwarden", server: "us", clientId: "user.abc", clientSecret: "secret-xyz" },
      "owner",
    );
    const body = { connectionId: conn.id, itemId: "item-1", fields: ["login.password"], purpose: "登录 GitHub 查 issue", target: "github.com" };
    await expect(s.credentials.request("a", "run-gone", body)).rejects.toThrow(/任务已结束/);
    await expect(s.credentials.request("a", "run-a", body)).rejects.toThrow(/解锁/);
    expect(s.credentials.requests()).toHaveLength(0);
  });

  it("never returns a secret through the overview, the item list or the access log", async () => {
    const s = await withRequest();
    await settle();
    const req = s.credentials.status(s.req.id, "a", "run-a");
    const reviewerRun = req.reviewerRunId!;
    s.credentials.decide(req.id, "approve", "用途明确", "reviewer", reviewerRun);
    await s.credentials.read(req.id, "a", "run-a", ["login.password"]);
    const dump = JSON.stringify(s.credentials.overview());
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("secret-xyz");
    expect(dump).not.toContain("master-password");
    expect(dump).toContain("GitHub");
    // The audit trail records names and field names, never the values.
    const trail = (s.db.prepare("SELECT action, detail FROM audit WHERE action LIKE 'credentials.%'").all() as { action: string; detail: string }[]);
    expect(trail.length).toBeGreaterThan(3);
    expect(JSON.stringify(trail)).not.toContain("hunter2");
    expect(JSON.stringify(trail)).not.toContain("secret-xyz");
    expect(JSON.stringify(trail)).not.toContain("master-password");
    expect(trail.map((t) => t.action)).toContain("credentials.read");
  });
});

describe("approval identity", () => {
  it("only the designated reviewer run can decide", async () => {
    const s = await withRequest();
    await settle();
    const req = s.credentials.status(s.req.id, "a", "run-a");
    expect(req.reviewerAgentId).toBe("reviewer");
    expect(req.reviewerRunId).toBe("review-1");

    // The requester cannot approve its own request, even by claiming to be the reviewer.
    expect(() => s.credentials.decide(req.id, "approve", "自己批", "a", "run-a")).toThrow(/只有指定审批任务/);
    expect(() => s.credentials.decide(req.id, "approve", "自己批", "reviewer", "run-a")).toThrow(/任务已结束或不匹配/);
    // An unrelated run of the reviewer agent cannot decide either.
    s.runs.rows.set("run-other", { id: "run-other", agent_id: "reviewer", status: "running" });
    expect(() => s.credentials.decide(req.id, "approve", "顺手批", "reviewer", "run-other")).toThrow(/只有指定审批任务/);
    // Another agent cannot decide.
    addAgent(s.db, "b");
    s.runs.rows.set("run-b", { id: "run-b", agent_id: "b", status: "running" });
    expect(() => s.credentials.decide(req.id, "approve", "越权", "b", "run-b")).toThrow(/只有指定审批任务/);

    expect(s.credentials.status(req.id, "a", "run-a").status).toBe("pending");
    const done = s.credentials.decide(req.id, "approve", "用途明确", "reviewer", "review-1");
    expect(done.status).toBe("approved");
    expect(done.reviewerRunId).toBe("review-1");
  });

  it("refuses to schedule a review when the approver is the requester itself", async () => {
    const s = await withRequest({ approver: "a" });
    await settle();
    expect(s.runs.sent).toHaveLength(0);
    expect(s.credentials.status(s.req.id, "a", "run-a").status).toBe("pending");
  });

  it("leaves the request to the owner when the review task ends without deciding", async () => {
    const s = await withRequest();
    await settle();
    s.runs.finish("review-1");
    const req = s.credentials.status(s.req.id, "a", "run-a");
    expect(req.status).toBe("pending");
    expect(req.reviewFailed).toBe(true);
    await settle();
    // No new review task: a failed review must not loop.
    expect(s.runs.sent).toHaveLength(1);
    // The owner can still decide it by hand.
    expect(s.credentials.decide(req.id, "approve", "主人自己批", "owner").status).toBe("approved");
  });
});

describe("grants", () => {
  it("starts the 10-minute window at approval, not at the request", async () => {
    const s = await withRequest();
    await settle();
    const pending = s.credentials.status(s.req.id, "a", "run-a");
    const approved = s.credentials.decide(s.req.id, "approve", "可以", "reviewer", pending.reviewerRunId!);
    const window = Date.parse(approved.grantExpiresAt!) - Date.parse(approved.decidedAt!);
    expect(window).toBeGreaterThan(599_000);
    expect(window).toBeLessThanOrEqual(600_000);
    expect(approved.expiresAt).toBe(approved.grantExpiresAt);
  });

  it("reads exactly once, only the approved fields", async () => {
    const s = await withRequest();
    await settle();
    const req = s.credentials.status(s.req.id, "a", "run-a");
    s.credentials.decide(req.id, "approve", "可以", "reviewer", req.reviewerRunId!);

    await expect(s.credentials.read(req.id, "a", "run-a", ["login.password", "login.totp"])).rejects.toThrow(/字段范围/);
    await expect(s.credentials.read(req.id, "a", "run-a", ["login.username"])).rejects.toThrow(/字段范围/);
    expect(s.provider.reads).toBe(0);

    await expect(s.credentials.read(req.id, "a", "run-a", ["login.password"])).resolves.toEqual({ "login.password": "hunter2" });
    await expect(s.credentials.read(req.id, "a", "run-a", ["login.password"])).rejects.toThrow(/未批准、已使用或已过期/);
    expect(s.provider.reads).toBe(1);
  });

  it("cannot be read from another run, another agent or after a revoke", async () => {
    const s = await withRequest();
    await settle();
    const req = s.credentials.status(s.req.id, "a", "run-a");
    s.credentials.decide(req.id, "approve", "可以", "reviewer", req.reviewerRunId!);

    await expect(s.credentials.read(req.id, "a", "run-elsewhere", ["login.password"])).rejects.toThrow();
    addAgent(s.db, "b");
    await expect(s.credentials.read(req.id, "b", "run-a", ["login.password"])).rejects.toThrow();
    expect(s.provider.reads).toBe(0);

    s.credentials.revoke(req.id, "owner");
    await expect(s.credentials.read(req.id, "a", "run-a", ["login.password"])).rejects.toThrow(/未批准、已使用或已过期/);
    expect(s.provider.reads).toBe(0);
  });

  it("dies with the requesting run and with a lock", async () => {
    const first = await withRequest();
    await settle();
    const a = first.credentials.status(first.req.id, "a", "run-a");
    first.credentials.decide(a.id, "approve", "可以", "reviewer", a.reviewerRunId!);
    first.runs.finish("run-a");
    expect(first.credentials.status(a.id, "a", "run-a").status).toBe("revoked");

    const second = await withRequest();
    await settle();
    const b = second.credentials.status(second.req.id, "a", "run-a");
    second.credentials.decide(b.id, "approve", "可以", "reviewer", b.reviewerRunId!);
    second.credentials.lock(second.conn.id, "owner");
    await expect(second.credentials.read(b.id, "a", "run-a", ["login.password"])).rejects.toThrow(/锁定|未批准/);
    expect(second.provider.reads).toBe(0);
  });

  it("refuses an approval made while the vault is locked", async () => {
    const s = await withRequest();
    await settle();
    const req = s.credentials.status(s.req.id, "a", "run-a");
    s.credentials.lock(s.conn.id, "owner");
    expect(() => s.credentials.decide(req.id, "approve", "可以", "reviewer", req.reviewerRunId!)).toThrow();
    expect(s.credentials.status(req.id, "a", "run-a").status).not.toBe("approved");
  });
});

describe("redaction", () => {
  it("scrubs a released secret before it is stored or streamed", async () => {
    const s = await withRequest();
    await settle();
    const req = s.credentials.status(s.req.id, "a", "run-a");
    s.credentials.decide(req.id, "approve", "可以", "reviewer", req.reviewerRunId!);
    await s.credentials.read(req.id, "a", "run-a", ["login.password"]);

    const seen: string[] = [];
    s.events.bus.on("message", (m: { kind: string; event?: { type: string } }) => {
      if (m.kind === "event") seen.push(JSON.stringify(m.event));
    });
    s.events.append("a", "conv", {
      type: "tool_call",
      runId: "run-a",
      name: "run_command",
      output: "logged in with hunter2 at github.com",
    } as never);

    const stored = (s.db.prepare("SELECT data FROM events WHERE run_id = 'run-a'").all() as { data: string }[]).map((r) => r.data).join("\n");
    expect(stored).not.toContain("hunter2");
    expect(stored).toContain("«secret»");
    expect(seen.join("\n")).not.toContain("hunter2");
  });

  it("redacts short values as whole words instead of mangling unrelated text", () => {
    expect(redact("the code is 1234 now", ["1234"])).toBe("the code is «secret» now");
    expect(redact("order x1234y shipped", ["1234"])).toBe("order x1234y shipped");
    expect(redact("token hunter2 here", ["hunter2"])).toBe("token «secret» here");
    expect(redact("no secret in sight", [])).toBe("no secret in sight");
  });
});
