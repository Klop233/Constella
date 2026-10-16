import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitAttachments, withAttachments } from "@constella/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-uploads-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CONSTELLA_SETUP_CODE = "setup-code";

const { createHub } = await import("../src/app.ts");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("attachment line", () => {
  it("round-trips the uploaded paths and leaves other text alone", () => {
    const paths = ["/workspace/uploads/1-a.png", "/workspace/uploads/2-报告.pdf"];
    expect(splitAttachments(withAttachments("看看这个\n\n第二段", paths))).toEqual({ text: "看看这个\n\n第二段", paths });
    expect(splitAttachments(withAttachments("", paths))).toEqual({ text: "", paths });
    expect(withAttachments("只有文字", [])).toBe("只有文字");
    // Not an upload list: kept as typed.
    for (const t of ["附件：见邮件", "说明\n\n附件：/etc/passwd", "前面附件：/workspace/uploads/1-a.png", "x\n\n附件：/workspace/uploads/sub/1-a.png"]) {
      expect(splitAttachments(t)).toEqual({ text: t, paths: [] });
    }
  });
});

describe("uploads through the hub", () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let base: string;
  let cookie = "";
  let agentId: string;

  const http = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { "X-Constella": "1", cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };

  beforeAll(async () => {
    hub = await createHub({ dbPath: ":memory:", webDist: path.join(tmp, "no-web") });
    await hub.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;
    await http("POST", "/api/auth/setup", { code: "setup-code", name: "主人", password: "a-long-password-1" });
    // A provider has to exist before an agent's model can resolve (nothing is built in).
    const provider = hub.models.addProvider({ name: "测试", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" });
    agentId = hub.agents.create({ name: "看图", template: "assistant" }, "test").id;
    hub.agents.update(agentId, { model: `test-model@${provider.id}` }, "test");
  });

  afterAll(async () => {
    await hub?.close();
  });

  it("stores into the workspace and serves images inline, other files as downloads", async () => {
    const up = await (await http("POST", `/api/agents/${agentId}/uploads`, { name: "截图 1.png", data: PNG.toString("base64") })).json();
    expect(up).toMatchObject({ image: true, path: expect.stringMatching(/^\/workspace\/uploads\/\d+-截图_1\.png$/) });
    const name = up.path.split("/").pop();
    expect(fs.readFileSync(path.join(tmp, "agents", agentId, "workspace", "uploads", name))).toEqual(PNG);

    const img = await http("GET", `/api/agents/${agentId}/uploads/${encodeURIComponent(name)}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toMatch(/^inline; .*filename\*=UTF-8''%E6%88%AA%E5%9B%BE_1\.png$/);
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);

    const doc = await (await http("POST", `/api/agents/${agentId}/uploads`, { name: "page.html", data: Buffer.from("<script>1</script>").toString("base64") })).json();
    expect(doc.image).toBe(false);
    const dl = await http("GET", `/api/agents/${agentId}/uploads/${encodeURIComponent(doc.path.split("/").pop())}`);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("refuses paths outside the uploads folder and unknown agents", async () => {
    expect((await http("GET", `/api/agents/${agentId}/uploads/..%2F..%2Fhome%2Fx`)).status).toBe(400);
    expect((await http("GET", `/api/agents/${agentId}/uploads/nope.png`)).status).toBe(404);
    expect((await http("GET", `/api/agents/..%2F..%2Fdb/uploads/x.png`)).status).not.toBe(200);
  });

  it("names a conversation started with only attachments after them", async () => {
    const res = await hub.runs.send({ agentId, text: withAttachments("", ["/workspace/uploads/1-a.png"]), images: ["/workspace/uploads/1-a.png"] });
    expect(hub.runs.conversation(res.conversationId)?.title).toBe("图片");
  });
});
