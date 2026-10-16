import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import type { FastifyInstance } from "fastify";
import type { AgentRow } from "./agents.ts";
import type { ModelRegistry } from "./models.ts";

/**
 * Codex only speaks the Responses API, while most model services (DeepSeek, Kimi, Qwen, GLM, SiliconFlow,
 * OpenRouter…) only offer Chat Completions. For a provider marked "chat", agents call this bridge instead: it turns
 * the Responses request into a Chat Completions one, calls the provider with its real key (which never enters the
 * agent container), and streams the answer back as Responses events.
 */

type Json = Record<string, any>;
type ToolKind = "function" | "custom" | "local_shell";
/** A tool as the model sees it (flat name) and as Codex knows it (name inside an optional namespace). */
export interface ToolRef {
  kind: ToolKind;
  name: string;
  namespace?: string;
}

export interface ChatRequest {
  model: string;
  messages: Json[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: Json[];
  tool_choice?: "auto";
  reasoning_effort?: string;
  max_tokens?: number;
  response_format?: Json;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

/** Text and images of a Responses content list (or a plain string). */
function parts(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content as Json[]) {
      if (typeof c === "string") texts.push(c);
      else if (c?.type === "input_image" && typeof c.image_url === "string") images.push(c.image_url);
      else if (typeof c?.text === "string") texts.push(c.text);
    }
  } else if (content && typeof content === "object") {
    const o = content as Json;
    if ("content" in o) return parts(o.content);
    if (typeof o.text === "string") texts.push(o.text);
  }
  return { text: texts.join("\n"), images };
}

function userContent(text: string, images: string[]): string | Json[] {
  if (!images.length) return text;
  return [...(text ? [{ type: "text", text }] : []), ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

function reasoningText(item: Json): string {
  const content = Array.isArray(item.content) ? (item.content as Json[]).map((c) => c?.text ?? "").join("") : "";
  if (content) return content;
  return Array.isArray(item.summary) ? (item.summary as Json[]).map((s) => s?.text ?? "").join("\n") : "";
}

/** Chat Completions has no namespaces: a tool inside one is offered as `namespace__name`. */
export function flatName(name: string, namespace?: string): string {
  if (!namespace) return name;
  return `${namespace}${namespace.endsWith("_") ? "" : "__"}${name}`;
}

/** Responses tools as Chat Completions functions; freeform (custom) tools take their text in one `input` string. */
function chatTools(tools: unknown, namespace?: string, out: Json[] = [], kinds = new Map<string, ToolRef>()): { tools: Json[]; kinds: Map<string, ToolRef> } {
  for (const t of Array.isArray(tools) ? (tools as Json[]) : []) {
    if (t?.type === "namespace" && t.name) {
      chatTools(t.tools, t.name, out, kinds);
    } else if (t?.type === "function" && t.name) {
      const flat = flatName(t.name, namespace);
      out.push({ type: "function", function: { name: flat, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } });
      kinds.set(flat, { kind: "function", name: t.name, ...(namespace ? { namespace } : {}) });
    } else if (t?.type === "custom" && t.name) {
      const format = t.format?.definition ? `\n\nThe input must follow this ${t.format.syntax ?? ""} grammar:\n${t.format.definition}` : "";
      out.push({
        type: "function",
        function: {
          name: t.name,
          description: `${t.description ?? ""}\n\nPass the raw text as the \`input\` argument.${format}`,
          parameters: { type: "object", properties: { input: { type: "string", description: "Raw input text" } }, required: ["input"], additionalProperties: false },
        },
      });
      kinds.set(t.name, { kind: "custom", name: t.name });
    } else if (t?.type === "local_shell") {
      out.push({
        type: "function",
        function: {
          name: "local_shell",
          description: "Runs a command on the local machine and returns its output.",
          parameters: {
            type: "object",
            properties: { command: { type: "array", items: { type: "string" } }, workdir: { type: "string" }, timeout_ms: { type: "number" } },
            required: ["command"],
          },
        },
      });
      kinds.set("local_shell", { kind: "local_shell", name: "local_shell" });
    }
    // Hosted tools (web search, image generation…) have no Chat Completions equivalent and are left out.
  }
  return { tools: out, kinds };
}

/** Every assistant tool call needs a tool reply before the conversation goes on, and no reply may be orphaned. */
function pairToolCalls(messages: Json[]): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") continue; // emitted together with their assistant message below
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const replies: Json[] = [];
    let j = i + 1;
    for (; j < messages.length && messages[j]!.role === "tool"; j++) replies.push(messages[j]!);
    for (const call of m.tool_calls as Json[]) {
      out.push(replies.find((r) => r.tool_call_id === call.id) ?? { role: "tool", tool_call_id: call.id, content: "(no output)" });
    }
    i = j - 1;
  }
  return out;
}

/** Turns a Responses API request (as Codex sends it) into a streaming Chat Completions request. */
export function toChatRequest(body: Json): { request: ChatRequest; kinds: Map<string, ToolRef> } {
  const system: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) system.push(body.instructions);
  const input: Json[] = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  const lastUser = input.findLastIndex((it) => (it.type ?? "message") === "message" && it.role === "user");
  const messages: Json[] = [];
  let reasoning: string | null = null;
  let toolImages: string[] = [];
  const flushImages = () => {
    if (!toolImages.length) return;
    messages.push({ role: "user", content: userContent("Images returned by the tool call above:", toolImages) });
    toolImages = [];
  };

  input.forEach((item, i) => {
    const type = item.type ?? (item.role ? "message" : "");
    if (type !== "function_call_output" && type !== "custom_tool_call_output") flushImages();
    if (type === "message") {
      const { text, images } = parts(item.content);
      if (item.role === "system" || item.role === "developer") {
        // Many chat templates only allow system text at the start; these stay valid for the whole conversation.
        if (text.trim()) system.push(text);
      } else if (item.role === "assistant") {
        // Codex keeps reasoning → text → tool calls; the reasoning belongs to this message and its calls.
        messages.push({ role: "assistant", content: text, ...(reasoning && i > lastUser ? { reasoning_content: reasoning } : {}) });
      } else {
        messages.push({ role: "user", content: userContent(text, images) });
      }
      reasoning = null;
    } else if (type === "reasoning") {
      reasoning = reasoningText(item) || null;
    } else if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      const args = type === "function_call" ? item.arguments || "{}" : type === "custom_tool_call" ? JSON.stringify({ input: item.input ?? "" }) : JSON.stringify(item.action ?? {});
      const name = type === "local_shell_call" ? "local_shell" : flatName(item.name, item.namespace);
      const call = { id: item.call_id ?? item.id ?? id("call"), type: "function", function: { name, arguments: args } };
      const last = messages.at(-1);
      const target = last?.role === "assistant" ? last : (messages.push({ role: "assistant", content: null }), messages.at(-1)!);
      (target.tool_calls ??= []).push(call);
      // Thinking models (DeepSeek, Kimi…) want their reasoning back on tool calls within the current turn.
      if (reasoning && i > lastUser) target.reasoning_content = reasoning;
      reasoning = null;
    } else if (type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output") {
      const { text, images } = parts(item.output);
      messages.push({ role: "tool", tool_call_id: item.call_id, content: text || (images.length ? "(see the images below)" : "(no output)") });
      toolImages.push(...images);
    }
  });
  flushImages();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.tool_calls && m.content === "") m.content = null;
    // Only tool-calling turns need their reasoning back; elsewhere some services reject the field.
    if (!m.tool_calls) delete m.reasoning_content;
  }

  const { tools, kinds } = chatTools(body.tools);
  const request: ChatRequest = {
    model: String(body.model ?? ""),
    messages: [...(system.length ? [{ role: "system", content: system.join("\n\n") }] : []), ...pairToolCalls(messages)],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) {
    request.tools = tools;
    request.tool_choice = "auto";
  }
  const effort = body.reasoning?.effort;
  if (typeof effort === "string" && effort !== "none") request.reasoning_effort = effort;
  if (typeof body.max_output_tokens === "number") request.max_tokens = body.max_output_tokens;
  const format = body.text?.format;
  if (format?.type === "json_schema" && format.schema) {
    request.response_format = { type: "json_schema", json_schema: { name: format.name ?? "output", schema: format.schema, strict: format.strict ?? false } };
  }
  return { request, kinds };
}

/**
 * Turns Chat Completions stream chunks into Responses API events. Reasoning (`reasoning_content`, `reasoning`, or
 * a leading `<think>` block) becomes a reasoning item, text a message, tool calls function / custom tool calls.
 */
export class ResponsesStream {
  readonly id = id("resp");
  #kinds: Map<string, ToolRef>;
  #model: string;
  #index = 0;
  #reasoning: { id: string; index: number; text: string } | null = null;
  #reasoningDone = false;
  #message: { id: string; index: number; text: string } | null = null;
  #pendingText = "";
  #thinkTag: "unknown" | "inside" | "none" = "unknown";
  #calls = new Map<number, { id: string; name: string; args: string }>();
  #usage: Json | null = null;
  #finished = false;
  #closed = false;

  constructor(model: string, kinds: Map<string, ToolRef>) {
    this.#model = model;
    this.#kinds = kinds;
  }

  start(): Json[] {
    return [{ type: "response.created", response: { id: this.id, object: "response", model: this.#model, status: "in_progress", output: [] } }];
  }

  /** Events for one parsed chunk. */
  chunk(chunk: Json): Json[] {
    const out: Json[] = [];
    if (chunk.error) return [this.failed(typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error)))];
    if (chunk.usage) this.#usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? choice.message ?? {};
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (typeof thought === "string" && thought) out.push(...this.#think(thought));
    if (typeof delta.content === "string" && delta.content) out.push(...this.#content(delta.content));
    if (Array.isArray(delta.tool_calls)) {
      out.push(...this.#closeReasoning());
      delta.tool_calls.forEach((tc: Json, n: number) => {
        const key = typeof tc.index === "number" ? tc.index : this.#calls.size + n;
        const cur = this.#calls.get(key) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        // The name normally arrives once; some services repeat it in every chunk, a few split it.
        const name = tc.function?.name;
        if (name && name !== cur.name) cur.name += name;
        if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
        else if (tc.function?.arguments && typeof tc.function.arguments === "object") cur.args = JSON.stringify(tc.function.arguments);
        this.#calls.set(key, cur);
      });
    }
    if (choice.finish_reason) this.#finished = true;
    return out;
  }

  #think(text: string): Json[] {
    const out: Json[] = [];
    if (!this.#reasoning) {
      this.#reasoning = { id: id("rs"), index: this.#index++, text: "" };
      out.push({ type: "response.output_item.added", output_index: this.#reasoning.index, item: { type: "reasoning", id: this.#reasoning.id, summary: [] } });
      out.push({ type: "response.reasoning_summary_part.added", item_id: this.#reasoning.id, output_index: this.#reasoning.index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    if (this.#reasoningDone) return out; // a late thought after the answer started: nothing sensible to do with it
    this.#reasoning.text += text;
    out.push({ type: "response.reasoning_summary_text.delta", item_id: this.#reasoning.id, output_index: this.#reasoning.index, summary_index: 0, delta: text });
    return out;
  }

  #closeReasoning(): Json[] {
    if (!this.#reasoning || this.#reasoningDone) return [];
    this.#reasoningDone = true;
    const r = this.#reasoning;
    return [
      {
        type: "response.output_item.done",
        output_index: r.index,
        item: { type: "reasoning", id: r.id, summary: [{ type: "summary_text", text: r.text }], content: [{ type: "reasoning_text", text: r.text }] },
      },
    ];
  }

  #content(text: string): Json[] {
    // Some services put the thinking into the text as a leading <think>…</think> block.
    if (this.#thinkTag !== "none") {
      this.#pendingText += text;
      if (this.#thinkTag === "unknown") {
        const head = this.#pendingText.trimStart();
        if (!head) return [];
        if ("<think>".startsWith(head)) return []; // could still become the tag
        if (!head.startsWith("<think>")) {
          this.#thinkTag = "none";
          const all = this.#pendingText;
          this.#pendingText = "";
          return this.#text(all);
        }
        this.#thinkTag = "inside";
        this.#pendingText = head.slice("<think>".length);
      }
      const end = this.#pendingText.indexOf("</think>");
      if (end < 0) {
        // Hold back what could be the start of the closing tag.
        const keep = Math.min(this.#pendingText.length, "</think>".length - 1);
        const ready = this.#pendingText.slice(0, this.#pendingText.length - keep);
        this.#pendingText = this.#pendingText.slice(ready.length);
        return ready ? this.#think(ready) : [];
      }
      const thought = this.#pendingText.slice(0, end);
      const rest = this.#pendingText.slice(end + "</think>".length).replace(/^\s+/, "");
      this.#pendingText = "";
      this.#thinkTag = "none";
      return [...(thought ? this.#think(thought) : []), ...(rest ? this.#text(rest) : [])];
    }
    return this.#text(text);
  }

  #text(text: string): Json[] {
    const out: Json[] = [];
    if (!this.#message) {
      if (!text.trim()) return out;
      out.push(...this.#closeReasoning());
      this.#message = { id: id("msg"), index: this.#index++, text: "" };
      out.push({
        type: "response.output_item.added",
        output_index: this.#message.index,
        item: { type: "message", id: this.#message.id, role: "assistant", status: "in_progress", content: [] },
      });
      out.push({ type: "response.content_part.added", item_id: this.#message.id, output_index: this.#message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    this.#message.text += text;
    out.push({ type: "response.output_text.delta", item_id: this.#message.id, output_index: this.#message.index, content_index: 0, delta: text });
    return out;
  }

  /** Closing events once the upstream stream ended; null when it ended before finishing (Codex retries). */
  end(sawDone: boolean): Json[] | null {
    if (this.#closed) return [];
    if (!sawDone && !this.#finished) return null;
    this.#closed = true;
    const out: Json[] = [];
    if (this.#pendingText) {
      const rest = this.#pendingText;
      this.#pendingText = "";
      out.push(...(this.#thinkTag === "inside" ? this.#think(rest) : this.#text(rest)));
    }
    out.push(...this.#closeReasoning());
    if (this.#message) {
      const m = this.#message;
      out.push({
        type: "response.output_item.done",
        output_index: m.index,
        item: { type: "message", id: m.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: m.text, annotations: [] }] },
      });
    }
    for (const [, c] of [...this.#calls].sort((a, b) => a[0] - b[0])) {
      const item = this.#toolItem(c);
      const index = this.#index++;
      out.push({ type: "response.output_item.added", output_index: index, item }, { type: "response.output_item.done", output_index: index, item });
    }
    const u = this.#usage;
    const input = Number(u?.prompt_tokens ?? 0);
    const output = Number(u?.completion_tokens ?? 0);
    out.push({
      type: "response.completed",
      response: {
        id: this.id,
        object: "response",
        model: this.#model,
        status: "completed",
        usage: {
          input_tokens: input,
          input_tokens_details: { cached_tokens: Number(u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0) },
          output_tokens: output,
          output_tokens_details: { reasoning_tokens: Number(u?.completion_tokens_details?.reasoning_tokens ?? 0) },
          total_tokens: Number(u?.total_tokens ?? input + output),
        },
      },
    });
    return out;
  }

  #toolItem(c: { id: string; name: string; args: string }): Json {
    const callId = c.id || id("call");
    const tool = this.#kinds.get(c.name) ?? { kind: "function" as const, name: c.name };
    const kind = tool.kind;
    const args = c.args.trim() || "{}";
    if (kind === "custom") {
      let input = args;
      try {
        const parsed = JSON.parse(args) as Json;
        if (typeof parsed.input === "string") input = parsed.input;
      } catch {
        // not JSON: the model passed the raw text, use it as is
      }
      return { type: "custom_tool_call", id: id("ctc"), status: "completed", call_id: callId, name: c.name, input };
    }
    if (kind === "local_shell") {
      let action: Json = {};
      try {
        action = JSON.parse(args) as Json;
      } catch {}
      return {
        type: "local_shell_call",
        id: id("lsh"),
        call_id: callId,
        status: "completed",
        action: { type: "exec", command: Array.isArray(action.command) ? action.command : [], working_directory: action.workdir, timeout_ms: action.timeout_ms },
      };
    }
    return { type: "function_call", id: id("fc"), call_id: callId, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: args };
  }

  failed(message: string, code = "upstream_error"): Json {
    this.#closed = true;
    return { type: "response.failed", response: { id: this.id, object: "response", status: "failed", error: { code, message: message.slice(0, 2000) } } };
  }
}

/** Splits an SSE byte stream into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const value of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

function decompressor(encoding: string | undefined): NodeJS.ReadWriteStream | null {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      return "createZstdDecompress" in zlib ? (zlib as any).createZstdDecompress() : null;
    default:
      return null;
  }
}

export function registerChatBridge(app: FastifyInstance, deps: { models: ModelRegistry; agentByToken: (token: string) => AgentRow | undefined }): void {
  const authorize = (header: unknown): boolean => {
    const auth = String(header ?? "");
    return auth.startsWith("Bearer ") && !!deps.agentByToken(auth.slice(7));
  };
  const providerOf = (pid: string) => {
    const p = deps.models.provider(pid);
    return p && p.api === "chat" && !p.builtin ? p : null;
  };

  app.register(async (scope) => {
    // Codex may compress large requests.
    scope.addHook("preParsing", async (req, _reply, payload) => {
      const d = decompressor(req.headers["content-encoding"] as string | undefined);
      if (!d) return payload;
      delete req.headers["content-encoding"];
      delete req.headers["content-length"];
      return (payload as Readable).pipe(d) as unknown as typeof payload;
    });

    scope.get("/api/llm/:provider/v1/models", async (req, reply) => {
      if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: { message: "unauthorized" } });
      const pid = (req.params as { provider: string }).provider;
      if (!providerOf(pid)) return reply.code(404).send({ error: { message: "unknown provider" } });
      const ids = await deps.models.remoteModels(pid).catch(() => [] as string[]);
      return { object: "list", data: ids.map((m) => ({ id: m, object: "model", owned_by: pid })) };
    });

    scope.post("/api/llm/:provider/v1/responses", { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
      if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: { message: "unauthorized" } });
      const pid = (req.params as { provider: string }).provider;
      const p = providerOf(pid);
      if (!p) return reply.code(404).send({ error: { message: `服务商 ${pid} 不存在或不是 Chat Completions 接口` } });
      const { request, kinds } = toChatRequest((req.body ?? {}) as Json);
      // The request's own "close" fires as soon as its body is read; the response's means the caller went away.
      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) abort.abort();
      });
      let upstream: Response;
      try {
        const key = deps.models.apiKey(pid);
        upstream = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(request),
          signal: abort.signal,
        });
      } catch (err) {
        return reply.code(502).send({ error: { message: `连不上 ${p.name}：${err instanceof Error ? err.message : String(err)}` } });
      }
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        let message = text.slice(0, 2000);
        try {
          const j = JSON.parse(text) as Json;
          message = j.error?.message ?? j.message ?? message;
        } catch {}
        // Same status as upstream, so Codex retries 429 / 5xx and reports the rest.
        return reply.code(upstream.status || 502).send({ error: { message: `${p.name}：${message}`, type: "upstream_error" } });
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (events: Json[]) => {
        for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const stream = new ResponsesStream(request.model, kinds);
      send(stream.start());
      let sawDone = false;
      try {
        for await (const data of sseData(upstream.body)) {
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          let chunk: Json;
          try {
            chunk = JSON.parse(data) as Json;
          } catch {
            continue;
          }
          const events = stream.chunk(chunk);
          send(events);
          if (events.some((e) => e.type === "response.failed")) {
            res.end();
            return;
          }
        }
        const closing = stream.end(sawDone);
        // Ending without response.completed makes Codex retry the request.
        if (closing) send(closing);
      } catch (err) {
        if (!abort.signal.aborted) send([stream.failed(`${p.name} 的回复中断：${err instanceof Error ? err.message : String(err)}`)]);
      }
      res.end();
    });
  });
}
