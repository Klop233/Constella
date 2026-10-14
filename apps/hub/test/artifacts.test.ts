import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-artifacts-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CONSTELLA_SETUP_CODE = "setup-code";

const { openDb } = await import("../src/db.ts");
const { EventStore } = await import("../src/events.ts");
const { Artifacts, applyEdits, classify, decodeLegacyText, safeFilename, textFilename } = await import("../src/artifacts.ts");
const { createHub } = await import("../src/app.ts");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("decodeLegacyText", () => {
  it("reads GBK and UTF-16 text, and refuses binary", () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // 中文\n
    expect(decodeLegacyText(gbk)).toBe("中文\n");
    expect(decodeLegacyText(Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]))).toBe("中文");
    expect(decodeLegacyText(Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBeNull();
  });
});

describe("classify", () => {
  it("goes by extension, but only trusts browser-rendered types when the bytes agree", () => {
    expect(classify("报告.md", Buffer.from("# 标题"))).toMatchObject({ kind: "markdown" });
    expect(classify("page.HTML", Buffer.from("<html>"))).toMatchObject({ kind: "html", mime: "text/html" });
    expect(classify("run.py", Buffer.from("print(1)"))).toMatchObject({ kind: "code", language: "python" });
    expect(classify("Dockerfile", Buffer.from("FROM node"))).toMatchObject({ kind: "code", language: "dockerfile" });
    expect(classify("chart.png", PNG)).toMatchObject({ kind: "image", mime: "image/png" });
    // An HTML page named .png must never be served as an image.
    expect(classify("evil.png", Buffer.from("<script>alert(1)</script>"))).toMatchObject({ kind: "file", mime: "application/octet-stream" });
    expect(classify("fake.pdf", Buffer.from("hello"))).toMatchObject({ kind: "file" });
    expect(classify("doc.pdf", Buffer.from("%PDF-1.7\n"))).toMatchObject({ kind: "pdf" });
    expect(classify("noext", PNG)).toMatchObject({ kind: "image" });
    expect(classify("notes", Buffer.from("纯文本内容"))).toMatchObject({ kind: "text" });
    expect(classify("blob.bin", Buffer.from([1, 0, 2, 3]))).toMatchObject({ kind: "file" });
    expect(classify("data.md", Buffer.from([0, 1, 2]))).toMatchObject({ kind: "file" });
    expect(classify("slides.pptx", Buffer.from("PK"))).toMatchObject({ kind: "file", mime: expect.stringContaining("presentation") });
    // A multi-byte character cut off at the end of the sample is still text.
    expect(classify("cut.txt", Buffer.from("中文").subarray(0, 4))).toMatchObject({ kind: "text" });
  });

  it("names files safely", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename('a:b*c?"d<e>f|g.txt')).toBe("a_b_c__d_e_f_g.txt");
    expect(safeFilename("...")).toBe("file");
    expect(textFilename("季度 报告/草稿", "markdown")).toBe("季度-报告-草稿.md");
    expect(textFilename("脚本", "code", "Python")).toBe("脚本.py");
    expect(textFilename("x", "code", "brainfuck")).toBe("x.txt");
  });

  it("applies exact, unique edits only", () => {
    expect(applyEdits("a $1 b", [{ old: "$1", new: "$&" }])).toBe("a $& b");
    expect(applyEdits("one two", [{ old: "one", new: "1" }, { old: "two", new: "2" }])).toBe("1 2");
    expect(() => applyEdits("x", [{ old: "y", new: "z" }])).toThrow(/没有找到/);
    expect(() => applyEdits("aa", [{ old: "a", new: "b" }])).toThrow(/不止一次/);
  });
});

describe("Artifacts", () => {
  let db: ReturnType<typeof openDb>;
  let events: InstanceType<typeof EventStore>;
  let store: InstanceType<typeof Artifacts>;
  let root: string;
  let ws: string;
  const published: { type: string; data: any }[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmp, "store-"));
    db = openDb(":memory:");
    events = new EventStore(db);
    events.bus.on("message", (m) => m.kind === "hub" && published.push(m));
    store = new Artifacts({ db, events, dir: path.join(root, "artifacts"), agentsDir: path.join(root, "agents") });
    ws = path.join(root, "agents", "ag1", "workspace");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.join(root, "agents", "ag1", "home"), { recursive: true });
    fs.mkdirSync(path.join(root, "agents", "ag2", "workspace"), { recursive: true });
    db.prepare("INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES ('cv1', 'ag1', '写报告', 'now', 'now')").run();
    db.prepare("INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, created_at) VALUES ('run1', 'cv1', 'ag1', 'p', 'running', 'm', 'now')").run();
  });

  const send = (p: string, extra: Partial<Parameters<typeof store.fromFile>[0]> = {}) => store.fromFile({ agentId: "ag1", runId: "run1", conversationId: "cv1", path: p, ...extra });

  it("maps container paths into the agent's own directories only", () => {
    expect(store.agentPath("ag1", "out/a.txt").host).toBe(path.join(ws, "out/a.txt"));
    expect(store.agentPath("ag1", "/workspace/a.txt").container).toBe("/workspace/a.txt");
    expect(store.agentPath("ag1", "~/notes.md").host).toBe(path.join(root, "agents", "ag1", "home", "notes.md"));
    expect(() => store.agentPath("ag1", "/tmp/a.txt")).toThrow(/只能用/);
    expect(() => store.agentPath("ag1", "/workspace/../../etc/passwd")).toThrow(/只能用/);
    expect(() => store.agentPath("ag1", "../ag2/workspace/x")).toThrow(/只能用/);
  });

  it("stores a sent file as v1, and a re-send of the same path and title as v2", async () => {
    fs.writeFileSync(path.join(ws, "report.md"), "# v1");
    const a = await send("report.md", { note: "初稿" });
    expect(a).toMatchObject({ agent_id: "ag1", conversation_id: "cv1", run_id: "run1", title: "report.md", kind: "markdown", version: 1, size: 4, source_path: "/workspace/report.md" });
    expect(fs.readFileSync(store.filePath(a.id, 1), "utf8")).toBe("# v1");
    // The delivered copy doesn't change when the agent keeps editing its workspace.
    fs.writeFileSync(path.join(ws, "report.md"), "# v2 longer");
    expect(fs.readFileSync(store.filePath(a.id, 1), "utf8")).toBe("# v1");
    const b = await send("/workspace/report.md");
    expect(b).toMatchObject({ id: a.id, version: 2, size: 11 });
    expect(store.versions(a.id).map((v) => [v.version, v.note, v.author])).toEqual([
      [2, null, "agent"],
      [1, "初稿", "agent"],
    ]);
    // A different title is a different deliverable.
    const c = await send("report.md", { title: "另一份" });
    expect(c.id).not.toBe(a.id);
    expect(published.some((m) => m.type === "artifact" && m.data.id === a.id && m.data.version === 2)).toBe(true);
  });

  it("updates the artifact it is told to, and only the agent's own", async () => {
    fs.writeFileSync(path.join(ws, "a.csv"), "x,y\n1,2\n");
    fs.writeFileSync(path.join(ws, "b.png"), PNG);
    const a = await send("a.csv");
    const b = await send("b.png", { artifactId: a.id, title: "图" });
    expect(b).toMatchObject({ id: a.id, version: 2, kind: "image", mime: "image/png", title: "图" });
    await expect(store.fromFile({ agentId: "ag2", runId: null, conversationId: null, path: "x", artifactId: a.id })).rejects.toThrow(/找不到成果/);
    expect(() => store.owned("ag2", a.id)).toThrow(/找不到成果/);
  });

  it("refuses symlinks that lead outside, directories, missing and special files", async () => {
    const secret = path.join(root, "secret.db");
    fs.writeFileSync(secret, "master key");
    fs.symlinkSync(secret, path.join(ws, "link.txt"));
    await expect(send("link.txt")).rejects.toThrow(/工作目录以外/);
    fs.symlinkSync("/etc/hostname", path.join(ws, "abs.txt"));
    await expect(send("abs.txt")).rejects.toThrow(/工作目录以外|找不到/);
    // A link that stays inside is fine.
    fs.writeFileSync(path.join(ws, "real.txt"), "ok");
    fs.symlinkSync(path.join(ws, "real.txt"), path.join(ws, "inner.txt"));
    expect((await send("inner.txt")).size).toBe(2);
    fs.mkdirSync(path.join(ws, "dir"));
    await expect(send("dir")).rejects.toThrow(/目录/);
    await expect(send("nope.txt")).rejects.toThrow(/找不到文件/);
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(ws, "pipe")]);
    await expect(send("pipe")).rejects.toThrow(/不是普通文件/);
    expect(fs.readdirSync(path.join(root, "artifacts", ".incoming")).length).toBe(0);
  });

  it("writes, edits, restores and reads text artifacts", () => {
    const a = store.saveText({ agentId: "ag1", runId: "run1", conversationId: "cv1", title: "方案", kind: "markdown", content: "# 方案\n第一节\n第二节", author: "agent" });
    expect(a).toMatchObject({ kind: "markdown", filename: "方案.md", mime: "text/markdown", version: 1 });
    const b = store.edit({ agentId: "ag1", artifactId: a.id, edits: [{ old: "第二节", new: "第二节（改）" }], note: "改第二节", runId: "run1", conversationId: "cv1" });
    expect(b.version).toBe(2);
    expect(store.text(a.id).text).toBe("# 方案\n第一节\n第二节（改）");
    expect(store.text(a.id, 1).text).toBe("# 方案\n第一节\n第二节");
    // The owner edits it in place; the agent's stale edit then fails instead of landing somewhere else.
    store.saveText({ agentId: "ag1", runId: null, conversationId: null, artifactId: a.id, content: "# 主人重写", author: "user" });
    expect(() => store.edit({ agentId: "ag1", artifactId: a.id, edits: [{ old: "第一节", new: "x" }], runId: "run1", conversationId: "cv1" })).toThrow(/没有找到/);
    const r = store.restore(a.id, 2);
    expect(r.version).toBe(4);
    expect(store.text(a.id).text).toContain("第二节（改）");
    expect(store.versions(a.id)[0]).toMatchObject({ author: "user", note: "恢复到第 2 版", kind: "markdown" });
    expect(store.text(a.id, undefined, 5)).toMatchObject({ truncated: true });
    expect(() => store.saveText({ agentId: "ag1", runId: null, conversationId: null, title: "x", kind: "image", content: "x", author: "agent" })).toThrow(/只有/);
  });

  it("won't edit or overwrite a binary file as text", async () => {
    fs.writeFileSync(path.join(ws, "c.png"), PNG);
    const a = await send("c.png");
    expect(() => store.edit({ agentId: "ag1", artifactId: a.id, edits: [{ old: "a", new: "b" }], runId: null, conversationId: null })).toThrow(/是文件/);
    expect(() => store.saveText({ agentId: "ag1", runId: null, conversationId: null, artifactId: a.id, content: "x", author: "agent" })).toThrow(/是文件/);
    expect(() => store.text(a.id)).toThrow(/不是文本/);
  });

  it("copies a version back into an existing directory, refusing symlinked targets and parents", () => {
    const a = store.saveText({ agentId: "ag1", runId: null, conversationId: null, title: "表", kind: "csv", content: "a,b\n1,2", author: "agent" });
    expect(() => store.exportTo("ag1", a.id, undefined, "in/t.csv")).toThrow(/不存在/);
    fs.mkdirSync(path.join(ws, "in"));
    expect(store.exportTo("ag1", a.id, undefined, "in/t.csv")).toEqual({ container: "/workspace/in/t.csv", size: 7 });
    expect(fs.readFileSync(path.join(ws, "in", "t.csv"), "utf8")).toBe("a,b\n1,2");
    const outside = path.join(root, "victim.txt");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(ws, "evil.csv"));
    expect(() => store.exportTo("ag1", a.id, undefined, "evil.csv")).toThrow(/符号链接/);
    fs.symlinkSync(root, path.join(ws, "up"));
    expect(() => store.exportTo("ag1", a.id, undefined, "up/victim.txt")).toThrow(/以外/);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(() => store.exportTo("ag1", a.id, undefined, "/workspace")).toThrow(/文件名/);
  });

  it("lists by agent, conversation (including later versions), kind and title", async () => {
    db.prepare("INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at) VALUES ('ag1', '助理', '✨', 'assistant', 'p', 'm', 'auto', '{}', 'h', 'now', 'now')").run();
    db.prepare("INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES ('cv2', 'ag1', '第二个', 'now', 'now')").run();
    db.prepare("INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, created_at) VALUES ('run2', 'cv2', 'ag1', 'p', 'running', 'm', 'now')").run();
    const a = store.saveText({ agentId: "ag1", runId: "run1", conversationId: "cv1", title: "100% 完成", kind: "text", content: "x", author: "agent" });
    store.saveText({ agentId: "ag1", runId: "run1", conversationId: "cv1", title: "代码", kind: "code", language: "go", content: "package main", author: "agent" });
    store.saveText({ agentId: "ag1", runId: "run2", conversationId: "cv2", artifactId: a.id, content: "y", author: "agent" });
    expect(store.list({ conversationId: "cv2" }).map((x) => x.id)).toEqual([a.id]);
    expect(store.list({ conversationId: "cv1" }).length).toBe(2);
    expect(store.list({ kinds: ["code"] }).map((x) => x.language)).toEqual(["go"]);
    expect(store.list({ q: "100%" }).map((x) => x.id)).toEqual([a.id]);
    expect(store.list({ q: "%" }).length).toBe(1);
    expect(store.item(a.id)).toMatchObject({ agent_name: "助理", conversation_title: "写报告", version: 2 });
    store.remove(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.versions(a.id)).toEqual([]);
    expect(fs.existsSync(path.join(root, "artifacts", a.id))).toBe(false);
  });
});

describe("artifacts through the hub (MCP tools + HTTP)", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base: string;
  let cookie = "";
  let agentId: string;
  let token: string;
  let client: InstanceType<typeof Client>;

  const http = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { "X-Constella": "1", cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  const json = async (method: string, url: string, body?: unknown) => {
    const res = await http(method, url, body);
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };

  beforeAll(async () => {
    hub = await createHub({ dbPath: ":memory:", webDist: path.join(tmp, "no-web") });
    await hub.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = hub.app.server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    await json("POST", "/api/auth/setup", { code: "setup-code", name: "主人", password: "a-long-password-1" });
    const agent = hub.agents.create({ name: "写手", template: "assistant" }, "test");
    agentId = agent.id;
    token = hub.agents.token(agentId);
    const now = new Date().toISOString();
    hub.db.prepare("INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES ('cv-x', ?, '交付测试', ?, ?)").run(agentId, now, now);
    hub.db.prepare("INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, last_event_at, created_at) VALUES ('run-x', 'cv-x', ?, 'p', 'running', 'm', ?, ?)").run(agentId, now, now);
    const ws = path.join(tmp, "agents", agentId, "workspace");
    fs.mkdirSync(path.join(ws, "out"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "agents", agentId, "home"), { recursive: true });
    fs.writeFileSync(path.join(ws, "out", "季度报告.html"), "<script>document.cookie</script><h1>报告</h1>");
    fs.writeFileSync(path.join(ws, "chart.png"), PNG);
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  });

  afterAll(async () => {
    await client?.close();
    await hub?.close();
  });

  it("exposes the tools to agents", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["send_file", "artifact_save", "artifact_edit", "artifact_list", "artifact_read"]));
  });

  it("send_file puts a card in the chat and the file in the library, served safely", async () => {
    const r = await tool("send_file", { path: "out/季度报告.html", title: "季度报告", note: "初稿" });
    expect(r.isError).toBe(false);
    const id = /成果 id (art_[\w-]+)/.exec(r.text)![1]!;
    const ev = hub.events.forRun("run-x").find((e) => e.type === "artifact");
    expect(ev).toMatchObject({ type: "artifact", artifactId: id, version: 1, title: "季度报告", kind: "html", filename: "季度报告.html", note: "初稿" });

    const list = await json("GET", "/api/artifacts?conversationId=cv-x");
    expect(list.map((a: any) => a.id)).toContain(id);
    const detail = await json("GET", `/api/artifacts/${id}`);
    expect(detail).toMatchObject({ title: "季度报告", agent_name: "写手", conversation_title: "交付测试", versions: [{ version: 1, author: "agent" }] });

    // HTML is shown as text, never rendered on the app's origin; everything is sandboxed and nosniff.
    const inline = await http("GET", `/api/artifacts/${id}/file`);
    expect(inline.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(inline.headers.get("content-security-policy")).toBe("sandbox");
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inline.headers.get("content-disposition")).toMatch(/^inline; filename="_+\.html"; filename\*=UTF-8''%E5%AD%A3/);
    expect(await inline.text()).toContain("<h1>报告</h1>");
    const dl = await http("GET", `/api/artifacts/${id}/file?v=1&download=1`);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(dl.headers.get("content-type")).toBe("text/html");
    expect(dl.headers.get("cache-control")).toContain("immutable");
    const part = await http("GET", `/api/artifacts/${id}/file`, undefined, { Range: "bytes=0-7" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toMatch(/^bytes 0-7\//);
    expect(await part.text()).toBe("<script>");
    expect((await http("GET", `/api/artifacts/${id}/file`, undefined, { Range: "bytes=999999-" })).status).toBe(416);

    const png = await tool("send_file", { path: "/workspace/chart.png" });
    const pid = /成果 id (art_[\w-]+)/.exec(png.text)![1]!;
    const img = await http("GET", `/api/artifacts/${pid}/file`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("refuses files outside the agent's directories", async () => {
    const r = await tool("send_file", { path: "/srv/constella/db/constella.db" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/只能用/);
    fs.symlinkSync(path.join(tmp, "db"), path.join(tmp, "agents", agentId, "workspace", "db-link"));
    const r2 = await tool("send_file", { path: "db-link" });
    expect(r2.isError).toBe(true);
  });

  it("artifact_save / edit / read / list, and the owner's edits and restores", async () => {
    const saved = await tool("artifact_save", { title: "旅行计划", type: "markdown", content: "# 旅行计划\n- 第一天：上海\n- 第二天：杭州" });
    const id = /成果 id (art_[\w-]+)/.exec(saved.text)![1]!;
    const edited = await tool("artifact_edit", { artifact_id: id, edits: [{ old: "杭州", new: "苏州" }], note: "改去苏州" });
    expect(edited.text).toMatch(/第 2 版/);
    const read = await tool("artifact_read", { artifact_id: id });
    expect(read.text).toContain("第二天：苏州");
    expect((await tool("artifact_read", { artifact_id: id, version: 1 })).text).toMatch(/最新是第 2 版[\s\S]*杭州/);
    expect((await tool("artifact_list", { query: "旅行" })).text).toContain(id);
    expect((await tool("artifact_edit", { artifact_id: id, edits: [{ old: "不存在", new: "x" }] })).isError).toBe(true);

    // The owner rewrites it in the app; the agent sees whose version it is.
    const own = await json("POST", `/api/artifacts/${id}/versions`, { content: "# 主人改的", note: "精简" });
    expect(own.version).toBe(3);
    expect((await tool("artifact_read", { artifact_id: id })).text).toMatch(/第 3 版（主人编辑）[\s\S]*主人改的/);
    expect((await json("GET", `/api/artifacts/${id}/content?v=2`)).text).toContain("苏州");
    const restored = await json("POST", `/api/artifacts/${id}/versions`, { restore: 2 });
    expect(restored.version).toBe(4);
    expect((await json("PATCH", `/api/artifacts/${id}`, { title: "苏杭两日游" })).title).toBe("苏杭两日游");

    // save_to copies it into the agent's workspace.
    const out = await tool("artifact_read", { artifact_id: id, save_to: "/workspace/plan.md" });
    expect(out.text).toContain("已保存到 /workspace/plan.md");
    expect(fs.readFileSync(path.join(tmp, "agents", agentId, "workspace", "plan.md"), "utf8")).toContain("苏州");

    const events = hub.events.forRun("run-x").filter((e) => e.type === "artifact" && e.artifactId === id);
    expect(events.map((e) => (e as { version: number }).version)).toEqual([1, 2]);

    await json("DELETE", `/api/artifacts/${id}`);
    expect((await http("GET", `/api/artifacts/${id}`)).status).toBe(404);
    expect((await tool("artifact_read", { artifact_id: id })).isError).toBe(true);
  });

  it("needs a login for the HTTP API", async () => {
    const res = await fetch(`${base}/api/artifacts`);
    expect(res.status).toBe(401);
  });
});
