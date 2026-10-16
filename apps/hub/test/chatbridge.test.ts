import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-bridge-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const { toChatRequest, ResponsesStream, registerChatBridge } = await import("../src/chatbridge.ts");
const { openDb } = await import("../src/db.ts");
const { ModelRegistry } = await import("../src/models.ts");
const { SecretBox, SecretStore } = await import("../src/secrets.ts");

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("Responses → Chat Completions request", () => {
  it("puts instructions and developer text into one leading system message", () => {
    const { request } = toChatRequest({
      model: "deepseek-chat",
      instructions: "你是助手",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "权限说明" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "换了模型" }] },
      ],
    });
    expect(request.messages).toEqual([
      { role: "system", content: "你是助手\n\n权限说明\n\n换了模型" },
      { role: "user", content: "你好" },
    ]);
    expect(request).toMatchObject({ model: "deepseek-chat", stream: true, stream_options: { include_usage: true } });
    expect(request.tools).toBeUndefined();
  });

  it("keeps images as image_url parts", () => {
    const { request } = toChatRequest({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_text", text: "看图" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] }],
    });
    expect(request.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] });
  });

  it("pairs tool calls with their outputs, merges parallel calls, and fills in a missing output", () => {
    const { request } = toChatRequest({
      model: "m",
      input: [
        { role: "user", content: "列目录" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "我来看看" }] },
        { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":["ls"]}' },
        { type: "function_call", call_id: "c2", name: "shell", arguments: '{"command":["pwd"]}' },
        { type: "function_call_output", call_id: "c1", output: "a.txt" },
        { type: "function_call_output", call_id: "orphan", output: "x" },
      ],
    });
    expect(request.messages).toEqual([
      { role: "user", content: "列目录" },
      {
        role: "assistant",
        content: "我来看看",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "shell", arguments: '{"command":["ls"]}' } },
          { id: "c2", type: "function", function: { name: "shell", arguments: '{"command":["pwd"]}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "tool", tool_call_id: "c2", content: "(no output)" },
    ]);
  });

  it("turns freeform tools into a function taking `input`, and hosted tools are dropped", () => {
    const { request, kinds } = toChatRequest({
      model: "m",
      input: [
        { role: "user", content: "改文件" },
        { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "p1", output: "Done" },
      ],
      tools: [
        { type: "function", name: "shell", description: "run", parameters: { type: "object", properties: { command: { type: "array" } } }, strict: false },
        { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
        { type: "web_search" },
      ],
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(request.tools?.map((t) => t.function.name)).toEqual(["shell", "apply_patch"]);
    expect(request.tools?.[1]?.function.parameters.required).toEqual(["input"]);
    expect(request.tools?.[1]?.function.description).toContain("start: x");
    expect(kinds.get("apply_patch")).toBe("custom");
    expect(request.messages[1]?.tool_calls[0].function.arguments).toBe('{"input":"*** Begin Patch"}');
    expect(request.reasoning_effort).toBe("high");
    expect(request.tool_choice).toBe("auto");
  });

  it("hands reasoning back on tool calls of the current turn only", () => {
    const { request } = toChatRequest({
      model: "m",
      input: [
        { role: "user", content: "一" },
        { type: "reasoning", id: "r0", summary: [{ type: "summary_text", text: "旧的想法" }] },
        { type: "function_call", call_id: "a", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output: "ok" },
        { role: "user", content: "二" },
        { type: "reasoning", id: "r1", summary: [], content: [{ type: "reasoning_text", text: "新的想法" }] },
        { type: "function_call", call_id: "b", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "b", output: "ok" },
      ],
    });
    const assistants = request.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.reasoning_content).toBeUndefined();
    expect(assistants[1]?.reasoning_content).toBe("新的想法");
  });
});

describe("Chat Completions stream → Responses events", () => {
  const chunk = (delta: object, extra: object = {}) => ({ choices: [{ index: 0, delta, ...extra }] });

  it("streams reasoning, then text, then tool calls, and completes with usage", () => {
    const s = new ResponsesStream("m", new Map([["apply_patch", "custom" as const]]));
    const events = [
      ...s.start(),
      ...s.chunk(chunk({ reasoning_content: "想" })),
      ...s.chunk(chunk({ reasoning_content: "一想" })),
      ...s.chunk(chunk({ content: "好的" })),
      ...s.chunk(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: '{"comm' } }] })),
      ...s.chunk(chunk({ tool_calls: [{ index: 0, function: { arguments: 'and":["ls"]}' } }] })),
      ...s.chunk(chunk({ tool_calls: [{ index: 1, id: "call_2", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' } }] }, { finish_reason: "tool_calls" })),
      ...s.chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 64 } } }),
      ...s.end(true)!,
    ];
    expect(types(events)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ]);
    const done = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    expect(done[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "想一想" }] });
    expect(done[1]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] });
    expect(done[2]).toMatchObject({ type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":["ls"]}' });
    expect(done[3]).toMatchObject({ type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" });
    expect(events.at(-1)!.response.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 120,
    });
  });

  it("reads a leading <think> block as reasoning, even when the tag is split across chunks", () => {
    const s = new ResponsesStream("m", new Map());
    const events = [...s.chunk(chunk({ content: "<thi" })), ...s.chunk(chunk({ content: "nk>先想</th" })), ...s.chunk(chunk({ content: "ink>\n答案" })), ...s.end(true)!];
    const done = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    expect(done[0]).toMatchObject({ type: "reasoning", content: [{ text: "先想" }] });
    expect(done[1]).toMatchObject({ type: "message", content: [{ text: "答案" }] });
  });

  it("leaves text that merely starts with < alone", () => {
    const s = new ResponsesStream("m", new Map());
    const events = [...s.chunk(chunk({ content: "<b>粗</b>" })), ...s.end(true)!];
    expect(events.find((e) => e.type === "response.output_item.done")!.item.content[0].text).toBe("<b>粗</b>");
  });

  it("has no completion for a stream that broke off, and reports upstream errors as failed", () => {
    const s = new ResponsesStream("m", new Map());
    s.chunk(chunk({ content: "半" }));
    expect(s.end(false)).toBeNull();
    const t = new ResponsesStream("m", new Map());
    expect(t.chunk({ error: { message: "quota exceeded" } })[0]).toMatchObject({ type: "response.failed", response: { error: { message: "quota exceeded" } } });
  });
});

describe("bridge route", () => {
  let upstream: http.Server;
  let upstreamUrl = "";
  let seen: { auth: string | undefined; body: any } | null = null;
  let mode: "ok" | "limit" = "ok";
  const app = Fastify();
  const db = openDb(":memory:");
  const models = new ModelRegistry({ db, secrets: new SecretStore(db, new SecretBox(Buffer.alloc(32, 7).toString("base64"))), newapiBaseUrl: "http://n", newapiKey: () => "" });

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen = { auth: req.headers.authorization, body: JSON.parse(raw) };
        if (mode === "limit") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "slow down" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "你" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    models.addProvider({ name: "Chat", baseUrl: upstreamUrl, apiKey: "sk-real", api: "chat" });
    registerChatBridge(app, { models, agentByToken: (t) => (t === "agent-token" ? ({ id: "ag1" } as never) : undefined) });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    upstream.close();
  });

  const call = (auth?: string) =>
    app.inject({
      method: "POST",
      url: "/api/llm/p-chat/v1/responses",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      payload: { model: "deepseek-chat", instructions: "hi", input: [{ role: "user", content: [{ type: "input_text", text: "打个招呼" }] }], stream: true },
    });

  it("refuses callers without an agent token", async () => {
    expect((await call()).statusCode).toBe(401);
    expect((await call("Bearer wrong")).statusCode).toBe(401);
  });

  it("calls the provider with its own key and streams Responses events back", async () => {
    mode = "ok";
    const res = await call("Bearer agent-token");
    expect(res.statusCode).toBe(200);
    expect(seen?.auth).toBe("Bearer sk-real");
    expect(seen?.body.messages).toEqual([
      { role: "system", content: "hi" },
      { role: "user", content: "打个招呼" },
    ]);
    const events = res.body
      .split("\n\n")
      .filter((b) => b.includes("data: "))
      .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
    expect(events[0].type).toBe("response.created");
    expect(events.at(-1).type).toBe("response.completed");
    expect(events.find((e) => e.type === "response.output_item.done").item.content[0].text).toBe("你好");
  });

  it("passes rate limits through with the same status so Codex retries", async () => {
    mode = "limit";
    const res = await call("Bearer agent-token");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toContain("slow down");
  });
});
