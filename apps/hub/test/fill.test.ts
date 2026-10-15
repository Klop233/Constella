import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-fill-"));
process.env.CONSTELLA_DATA_DIR = tmp;

const { openDb } = await import("../src/db.ts");
const { registerMcp } = await import("../src/mcp.ts");
const { itemMatchesHost, siteHost } = await import("../src/credentials.ts");

describe("matching vault items to a site", () => {
  it("compares hosts, ignoring scheme, www and path, and allows subdomains", () => {
    expect(siteHost("https://www.Example.com/login?x=1")).toBe("example.com");
    expect(siteHost("example.com")).toBe("example.com");
    expect(siteHost("")).toBeNull();
    expect(itemMatchesHost(["https://example.com"], "login.example.com")).toBe(true);
    expect(itemMatchesHost(["https://accounts.example.com/signin"], "example.com")).toBe(true);
    expect(itemMatchesHost(["https://example.com"], "notexample.com")).toBe(false);
    expect(itemMatchesHost(["android://abc"], "example.com")).toBe(false);
  });
});

/** One input on a fake page; remembers what was filled. */
function fakePage(url: string, snapshot: (filled: Record<string, string>) => string) {
  const filled: Record<string, string> = {};
  const pressed: string[] = [];
  const input = (key: string) => ({ first: () => ({ fill: async (v: string) => void (filled[key] = v), press: async (k: string) => void pressed.push(k) }) });
  return {
    filled,
    pressed,
    url: () => url,
    title: async () => "登录",
    locator: () => ({ ariaSnapshot: async () => snapshot(filled) }),
    getByLabel: (label: string) => input(label),
    getByPlaceholder: (label: string) => input(label),
    getByRole: (_r: string, o?: { name?: string }) => input(o?.name ?? "role"),
    waitForLoadState: async () => {},
  };
}

type SecretAsk = { summary: string; spec: any };

async function withTools<T>(
  opts: {
    page?: ReturnType<typeof fakePage>;
    asked?: (a: SecretAsk) => unknown;
    vaultItems?: { connection: { id: string; name: string }; item: { id: string; name: string; username?: string } }[];
    approver?: string | null;
    settled?: { status: string; reason?: string };
  },
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>, seen: Record<string, unknown[]>) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at)
     VALUES ('a', 'a', '✨', 'assistant', 'p', 'm', 'auto', '{}', 'h', 'now', 'now')`,
  ).run();
  db.prepare("INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, created_at, last_event_at) VALUES ('r1', 'c1', 'a', 'p', 'running', 'm', 'now', 'now')").run();
  const seen: Record<string, unknown[]> = { asked: [], requested: [], decided: [], read: [], remembered: [], actions: [], logged: [], revoked: [] };
  const page = opts.page ?? fakePage("https://login.example.com/signin", () => "");
  const app = Fastify();
  registerMcp(app, {
    db,
    agents: { byToken: (t: string) => (t === "tok" ? { id: "a", name: "a", host_access: 0 } : undefined) },
    runs: {
      appendFor: () => {},
      requestSecret: async (_r: string, summary: string, spec: unknown) => {
        seen.asked!.push({ summary, spec });
        return opts.asked!({ summary, spec });
      },
    },
    desktops: {
      acquire: async () => "dt1",
      page: async () => page,
      action: async (_id: string, a: unknown) => void seen.actions!.push(a),
      describe: () => "浏览器",
      row: () => ({}),
      diagnose: async () => ({ ok: true }),
    },
    credentials: {
      approver: () => opts.approver ?? null,
      match: async () => opts.vaultItems ?? [],
      request: async (_a: string, _r: string, input: unknown) => (seen.requested!.push(input), { id: "cr1" }),
      decide: (...args: unknown[]) => void seen.decided!.push(args),
      settled: async () => opts.settled ?? { status: "approved" },
      read: async (_id: string, _a: string, _r: string, fields: string[]) => (seen.read!.push(fields), { "login.username": "vault-user", "login.password": "vault-p4ssword" }),
      remember: (v: string[]) => void seen.remembered!.push(...v),
      revoke: (id: string) => void seen.revoked!.push(id),
      logFill: (_a: string, detail: unknown) => void seen.logged!.push(detail),
    },
    browserHtml: () => false,
    instanceApproval: () => ({ create: false, update: false }),
  } as any);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "test", version: "0" });
  const url = new URL(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer tok" } } }));
  try {
    return await fn(async (name, args) => (await client.callTool({ name, arguments: args })) as any, seen);
  } finally {
    await client.close();
    await app.close();
  }
}

const ENTRIES = [
  { field: "login.username", label: "邮箱" },
  { field: "login.password", label: "密码" },
];

describe("credentials_fill", () => {
  it("asks on the chat page when the vault has nothing, and fills without echoing the password", async () => {
    const page = fakePage("https://login.example.com/signin", (f) => `textbox "密码": ${f["密码"] ?? ""}\ntextbox "邮箱": ${f["邮箱"] ?? ""}`);
    await withTools(
      { page, asked: () => ({ status: "provided", values: { "login.username": "me@x.com", "login.password": "s3cret-typed-pw" }, actor: "user" }) },
      async (call, seen) => {
        const res = await call("credentials_fill", { entries: ENTRIES, submit: true });
        expect(res.isError).toBeFalsy();
        expect(page.filled).toEqual({ 邮箱: "me@x.com", 密码: "s3cret-typed-pw" });
        expect(page.pressed).toEqual(["Enter"]);
        const out = res.content[0]!.text;
        expect(out).not.toContain("s3cret-typed-pw");
        expect(out).toContain("«secret»");
        expect(out).toContain("me@x.com");
        const ask = seen.asked![0] as SecretAsk;
        expect(ask.spec.target).toBe("login.example.com");
        expect(ask.spec.fields.map((f: { name: string }) => f.name)).toEqual(["login.username", "login.password"]);
        expect(ask.spec.vault).toBeUndefined();
        expect(seen.remembered).toEqual(["s3cret-typed-pw"]);
        expect(seen.requested).toEqual([]);
        expect(seen.logged).toEqual([{ target: "login.example.com", fields: ["login.username", "login.password"], via: "typed" }]);
      },
    );
  });

  it("offers the matching vault item to the owner and fills from it once allowed", async () => {
    const page = fakePage("https://example.com/login", () => "");
    await withTools(
      {
        page,
        vaultItems: [{ connection: { id: "c1", name: "个人" }, item: { id: "i1", name: "Example", username: "vault-user" } }],
        asked: () => ({ status: "vault", actor: "owner-1" }),
      },
      async (call, seen) => {
        const res = await call("credentials_fill", { entries: ENTRIES });
        expect(res.isError).toBeFalsy();
        expect((seen.asked![0] as SecretAsk).spec.vault).toEqual({ name: "Example", username: "vault-user" });
        expect(seen.requested).toEqual([{ connectionId: "c1", itemId: "i1", fields: ["login.username", "login.password"], purpose: "登录 example.com", target: "example.com" }]);
        expect(seen.decided).toEqual([["cr1", "approve", "主人在聊天里允许使用", "owner-1"]]);
        expect(page.filled).toEqual({ 邮箱: "vault-user", 密码: "vault-p4ssword" });
        expect(res.content[0]!.text).not.toContain("vault-p4ssword");
        expect(seen.logged).toEqual([{ target: "example.com", fields: ["login.username", "login.password"], via: "vault" }]);
      },
    );
  });

  it("goes through the approval agent when one is set, and asks the owner only if it says no", async () => {
    const item = { connection: { id: "c1", name: "个人" }, item: { id: "i1", name: "Example" } };
    const okPage = fakePage("https://example.com/login", () => "");
    await withTools({ page: okPage, vaultItems: [item], approver: "rev", asked: () => ({ status: "ended" }) }, async (call, seen) => {
      const res = await call("credentials_fill", { entries: ENTRIES });
      expect(res.isError).toBeFalsy();
      expect(seen.asked).toEqual([]);
      expect(okPage.filled).toEqual({ 邮箱: "vault-user", 密码: "vault-p4ssword" });
    });

    const deniedPage = fakePage("https://example.com/login", () => "");
    await withTools(
      {
        page: deniedPage,
        vaultItems: [item],
        approver: "rev",
        settled: { status: "denied", reason: "目标不符" },
        asked: () => ({ status: "provided", values: { "login.username": "u", "login.password": "typed-pw-123" }, actor: "user" }),
      },
      async (call, seen) => {
        await call("credentials_fill", { entries: ENTRIES });
        const ask = seen.asked![0] as SecretAsk;
        expect(ask.spec.note).toContain("目标不符");
        expect(ask.spec.vault).toBeUndefined();
        expect(deniedPage.filled).toEqual({ 邮箱: "u", 密码: "typed-pw-123" });
      },
    );
  });

  it("tells the agent that stopping without the login is fine when the owner doesn't provide it", async () => {
    const page = fakePage("https://example.com/login", () => "");
    for (const status of ["declined", "timeout"]) {
      await withTools({ page, asked: () => ({ status }) }, async (call) => {
        const res = await call("credentials_fill", { entries: ENTRIES });
        expect(res.isError).toBeFalsy();
        expect(res.content[0]!.text).toContain("不算失败");
        expect(page.filled).toEqual({});
      });
    }
  });

  it("types into the focused field when no locator is given, one field at a time", async () => {
    await withTools({ asked: () => ({ status: "provided", values: { "login.password": "pw-from-owner" }, actor: "user" }) }, async (call, seen) => {
      const two = await call("credentials_fill", { entries: [{ field: "login.username" }, { field: "login.password" }], site: "app.example.com" });
      expect(two.isError).toBe(true);
      const one = await call("credentials_fill", { entries: [{ field: "login.password" }], site: "app.example.com", submit: true });
      expect(one.isError).toBeFalsy();
      expect(seen.actions).toEqual([{ type: "type", text: "pw-from-owner" }, { type: "key", keys: "Enter" }]);
      expect(one.content[0]!.text).not.toContain("pw-from-owner");
      expect((seen.asked![0] as SecretAsk).spec.target).toBe("app.example.com");
    });
  });
});
