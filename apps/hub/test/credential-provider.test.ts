import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-bw-"));
process.env.CONSTELLA_DATA_DIR = tmp;

const { openDb } = await import("../src/db.ts");
const { SecretBox, SecretStore } = await import("../src/secrets.ts");
const { BitwardenProvider, serverProblem, serverUrl } = await import("../src/credential-provider.ts");
type Db = ReturnType<typeof openDb>;

const KEY = Buffer.alloc(32, 3).toString("base64");

const ITEM = { id: "item-1", name: "GitHub", type: 1, login: { username: "me", password: "hunter2", totp: "otpauth://x", uris: [{ uri: "https://github.com" }] } };

/** Records every CLI call and answers with canned output. */
function fakeCli(answers: (args: string[]) => unknown = () => "") {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; input?: string }[] = [];
  const run = async (env: NodeJS.ProcessEnv, args: string[], input?: string): Promise<string> => {
    calls.push({ args, env, input });
    const out = answers(args);
    if (out instanceof Error) throw out;
    return typeof out === "string" ? out : JSON.stringify(out);
  };
  return { calls, run, last: () => calls[calls.length - 1]!, find: (name: string) => calls.find((c) => c.args[0] === name) };
}

function setup(answers?: (args: string[]) => unknown) {
  const db: Db = openDb(":memory:");
  const secrets = new SecretStore(db, new SecretBox(KEY));
  const cli = fakeCli(answers ?? defaultAnswers);
  const root = fs.mkdtempSync(path.join(tmp, "cli-"));
  const provider = new BitwardenProvider(secrets, root, cli.run);
  return { db, secrets, cli, root, provider };
}

function defaultAnswers(args: string[]): unknown {
  if (args[0] === "status") return { status: "unauthenticated" };
  if (args[0] === "unlock") return "session-key-123";
  if (args[0] === "list") return [ITEM, { id: "note-1", name: "笔记", type: 2 }];
  if (args[0] === "get" && args[1] === "item") return ITEM;
  if (args[0] === "get" && args[1] === "totp") return "654321";
  if (args[0] === "create") return { id: "item-new", type: 1 };
  return "";
}

function connect(s: ReturnType<typeof setup>, server: string, caCert?: string) {
  s.secrets.set("credentials.cred_a", "clientId", "user.abc");
  s.secrets.set("credentials.cred_a", "clientSecret", "client-secret");
  if (caCert) s.secrets.set("credentials.cred_a", "caCert", caCert);
  return { id: "cred_a", name: "家用", provider: "bitwarden" as const, server };
}

const saved = process.env.NODE_EXTRA_CA_CERTS;
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = saved;
});

describe("third-party vault servers", () => {
  it("accepts the official regions, any https server, and http only on a private host", () => {
    expect(serverProblem("us")).toBeNull();
    expect(serverProblem("eu")).toBeNull();
    expect(serverProblem("https://vault.bitwarden.com")).toBeNull();
    expect(serverProblem("https://vault.example.com/")).toBeNull();
    expect(serverProblem("https://vault.example.com:8443")).toBeNull();
    expect(serverProblem("http://192.168.1.10:8080")).toBeNull();
    expect(serverProblem("http://vault.local")).toBeNull();
    expect(serverProblem("http://100.64.0.9:8081")).toBeNull();
    expect(serverProblem("http://vault.example.com")).toMatch(/https/);
    expect(serverProblem("vault.example.com")).toMatch(/https/);
    expect(serverProblem("https://user:pw@vault.example.com")).toMatch(/用户名/);
    expect(serverProblem("https://vault.example.com/?x=1")).toMatch(/查询参数/);
  });

  it("normalizes the server for the CLI", () => {
    expect(serverUrl("us")).toBe("https://vault.bitwarden.com");
    expect(serverUrl("eu")).toBe("https://vault.bitwarden.eu");
    expect(serverUrl("https://vault.example.com///")).toBe("https://vault.example.com");
  });
});

describe("Bitwarden CLI contract", () => {
  it("logs in with the API key and unlocks into a session, in the connection's own home", async () => {
    const s = setup();
    const c = connect(s, "https://vault.example.com");
    await s.provider.unlock(c, "master-password");

    expect(s.cli.calls.map((x) => x.args.slice(0, 2).join(" "))).toEqual([
      "status",
      "config server",
      "login --apikey",
      "unlock --passwordenv",
    ]);
    expect(s.cli.find("config")!.args).toEqual(["config", "server", "https://vault.example.com"]);
    expect(s.cli.find("login")!.env.BW_CLIENTID).toBe("user.abc");
    expect(s.cli.find("login")!.env.BW_CLIENTSECRET).toBe("client-secret");
    expect(s.cli.find("unlock")!.env.CONSTELLA_BW_PASSWORD).toBe("master-password");
    // Nothing is passed on the command line, and every call stays inside the connection's home.
    for (const call of s.cli.calls) {
      expect(call.args.join(" ")).not.toContain("master-password");
      expect(call.env.BITWARDENCLI_APPDATA_DIR).toBe(path.join(s.root, "cred_a"));
      expect(call.env.HOME).toBe(path.join(s.root, "cred_a"));
    }
    expect(s.provider.unlocked("cred_a")).toBe(true);
  });

  it("keeps each connection's CLI state apart", async () => {
    const s = setup();
    const a = connect(s, "us");
    const b = { id: "cred_b", name: "公司", provider: "bitwarden" as const, server: "https://vault.corp.example" };
    s.secrets.set("credentials.cred_b", "clientId", "u2");
    s.secrets.set("credentials.cred_b", "clientSecret", "s2");
    await s.provider.unlock(a, "pw-a");
    await s.provider.unlock(b, "pw-b");
    const dirs = new Set(s.cli.calls.map((c) => c.env.BITWARDENCLI_APPDATA_DIR));
    expect(dirs).toEqual(new Set([path.join(s.root, "cred_a"), path.join(s.root, "cred_b")]));
    expect(fs.statSync(path.join(s.root, "cred_b")).mode & 0o777).toBe(0o700);
  });

  it("hands a third-party server's own CA to the CLI, from an encrypted store", async () => {
    const s = setup();
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const c = connect(s, "https://vault.internal.example", pem);
    await s.provider.unlock(c, "pw");

    const caFile = s.cli.find("status")!.env.NODE_EXTRA_CA_CERTS!;
    expect(caFile).toBe(path.join(s.root, "cred_a", "ca.pem"));
    expect(fs.readFileSync(caFile, "utf8")).toBe(pem);
    expect(fs.statSync(caFile).mode & 0o777).toBe(0o600);
    // The PEM is not sitting in the database in the clear.
    const rows = s.db.prepare("SELECT value FROM secrets WHERE name = 'caCert'").all() as { value: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).not.toContain("BEGIN CERTIFICATE");
  });

  it("falls back to the host trust store when no CA was given", async () => {
    process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/host-ca.pem";
    const s = setup();
    await s.provider.unlock(connect(s, "us"), "pw");
    expect(s.cli.find("status")!.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/host-ca.pem");
  });

  it("reads only login items, and only the fields that were asked for", async () => {
    const s = setup();
    const c = connect(s, "us");
    await s.provider.unlock(c, "pw");

    const items = await s.provider.items(c);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "item-1", name: "GitHub", username: "me", fields: ["login.username", "login.password", "login.totp"] });
    expect(JSON.stringify(items)).not.toContain("hunter2");

    await expect(s.provider.read(c, "item-1", ["login.password", "login.totp"])).resolves.toEqual({ "login.password": "hunter2", "login.totp": "654321" });
    expect(s.cli.find("list")!.env.BW_SESSION).toBe("session-key-123");
  });

  it("refuses an item the CLI resolved to something else", async () => {
    // `bw get item` also accepts a search term, so a stale id could otherwise fetch a different item.
    const s = setup((args) => (args[0] === "get" && args[1] === "item" ? { ...ITEM, id: "item-9" } : defaultAnswers(args)));
    const c = connect(s, "us");
    await s.provider.unlock(c, "pw");
    await expect(s.provider.read(c, "item-1", ["login.password"])).rejects.toThrow(/条目无效/);
  });

  it("stops reading once the session is locked", async () => {
    const s = setup();
    const c = connect(s, "us");
    await s.provider.unlock(c, "pw");
    s.provider.lock("cred_a");
    expect(s.provider.unlocked("cred_a")).toBe(false);
    await expect(s.provider.items(c)).rejects.toThrow(/先解锁/);
  });

  it("never forwards the CLI's own output in an error", async () => {
    const s = setup((args) => (args[0] === "status" ? { status: "unauthenticated" } : new Error("vault dump: hunter2 / session-key-123")));
    const c = connect(s, "us");
    await expect(s.provider.unlock(c, "pw")).rejects.toThrow("Bitwarden 操作失败，请检查连接、登录信息或解锁状态");
    await expect(s.provider.unlock(c, "pw")).rejects.not.toThrow(/hunter2|session-key/);
  });
});

describe("creating a login", () => {
  it("sends the item on stdin, never on the command line, and needs an unlocked vault", async () => {
    const s = setup();
    const c = connect(s, "us");
    await expect(s.provider.create(c, { name: "example.com", username: "me", password: "typed-pw-9", uri: "https://example.com" })).rejects.toThrow("解锁");
    await s.provider.unlock(c, "master");
    const id = await s.provider.create(c, { name: "example.com", username: "me", password: "typed-pw-9", uri: "https://example.com" });
    expect(id).toBe("item-new");
    const call = s.cli.find("create")!;
    expect(call.args).toEqual(["create", "item"]);
    expect(JSON.stringify(call.args)).not.toContain("typed-pw-9");
    expect(call.env.BW_SESSION).toBe("session-key-123");
    const sent = JSON.parse(Buffer.from(call.input!, "base64").toString());
    expect(sent).toMatchObject({ type: 1, name: "example.com", login: { username: "me", password: "typed-pw-9", uris: [{ uri: "https://example.com" }] } });
  });
});
