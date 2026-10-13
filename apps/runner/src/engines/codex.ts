import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { HubToRunner, RunnerEvent } from "@constella/protocol";

type StartCmd = Extract<HubToRunner, { t: "start" }>;
type Json = Record<string, any>;

export interface EngineSink {
  event(event: RunnerEvent): void;
  thread(runId: string, threadId: string): void;
  done(runId: string, status: "done" | "failed" | "cancelled", error?: string): void;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  turnId: string | null;
  model: string;
  /** Commands output budget per tool call, to keep the event log bounded. */
  outputBytes: Map<string, number>;
  reasoning: Map<string, string>;
  /** When the current model request began: turn start, the last tool finishing, or the previous usage report. */
  requestStart: number;
  /** Whether the model has done anything this turn; usage reported before that is a replay of the previous turn. */
  active: boolean;
  lastError?: string;
}

/** Item types that are tool calls; when one completes, the model's next request begins. */
const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "collabAgentToolCall", "sleep"]);

interface PendingApproval {
  rpcId: number | string;
  runId: string;
}

const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_CHUNK = 4 * 1024;

/** Drives `codex app-server` (JSON-RPC over stdio) and maps its notifications to Constella events. */
export class CodexEngine {
  readonly name = "codex";
  #proc: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #runsByThread = new Map<string, ActiveRun>();
  #runs = new Map<string, ActiveRun>();
  #approvals = new Map<string, PendingApproval>();
  #skillRoots = "";
  #ready: Promise<void> | null = null;
  #sink: EngineSink;

  constructor(sink: EngineSink) {
    this.#sink = sink;
  }

  activeRunIds(): string[] {
    return [...this.#runs.keys()];
  }

  async start(cmd: StartCmd): Promise<void> {
    try {
      await this.#ensureProcess();
      const roots = JSON.stringify(cmd.skillRoots);
      if (roots !== this.#skillRoots) {
        await this.#request("skills/extraRoots/set", { extraRoots: cmd.skillRoots });
        this.#skillRoots = roots;
      }
      const threadParams = {
        model: cmd.model,
        cwd: "/workspace",
        approvalPolicy: cmd.approvalPolicy === "ask" ? "untrusted" : "never",
        sandbox: "danger-full-access",
        developerInstructions: cmd.instructions,
      };
      let threadId = cmd.threadId;
      if (threadId) {
        try {
          await this.#request("thread/resume", { threadId, ...threadParams, excludeTurns: true });
        } catch {
          threadId = null; // thread lost (e.g. home wiped); start fresh
        }
      }
      if (!threadId) {
        const res = await this.#request("thread/start", threadParams);
        threadId = res.thread.id as string;
      }
      this.#sink.thread(cmd.runId, threadId);
      const run: ActiveRun = {
        runId: cmd.runId,
        threadId,
        turnId: null,
        model: cmd.model,
        outputBytes: new Map(),
        reasoning: new Map(),
        requestStart: Date.now(),
        active: false,
      };
      this.#runs.set(cmd.runId, run);
      this.#runsByThread.set(threadId, run);
      const input: Json[] = [{ type: "text", text: cmd.text, text_elements: [] }];
      for (const img of cmd.images ?? []) {
        input.push(img.startsWith("/") ? { type: "localImage", path: img } : { type: "image", url: img });
      }
      const res = await this.#request("turn/start", {
        threadId,
        input,
        model: cmd.model,
        ...(cmd.effort ? { effort: cmd.effort } : {}),
        summary: "auto",
      });
      run.turnId = res.turn.id as string;
    } catch (err) {
      this.#finish(cmd.runId, "failed", errMessage(err));
    }
  }

  async steer(runId: string, text: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run?.turnId) return;
    await this.#request("turn/steer", {
      threadId: run.threadId,
      expectedTurnId: run.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return;
    if (!run.turnId) return this.#finish(runId, "cancelled");
    await this.#request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => {
      this.#finish(runId, "cancelled");
    });
  }

  resolveApproval(approvalId: string, decision: "approve" | "deny"): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) return;
    this.#approvals.delete(approvalId);
    this.#write({ id: pending.rpcId, result: { decision: decision === "approve" ? "accept" : "decline" } });
  }

  stop(): void {
    this.#proc?.kill();
  }

  #ensureProcess(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      this.#proc = proc;
      proc.stderr.on("data", (d: Buffer) => {
        const line = d.toString().trim();
        if (line && !/bubblewrap/i.test(line)) console.error(`[codex] ${line.slice(0, 500)}`);
      });
      readline.createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
      proc.on("exit", (code) => {
        console.error(`[codex] app-server exited (${code})`);
        this.#proc = null;
        this.#ready = null;
        this.#skillRoots = "";
        for (const p of this.#pending.values()) p.reject(new Error("codex app-server exited"));
        this.#pending.clear();
        for (const runId of [...this.#runs.keys()]) this.#finish(runId, "failed", "codex app-server exited");
      });
      this.#request("initialize", { clientInfo: { name: "constella", version: "0.1.0" }, capabilities: null })
        .then(() => {
          this.#write({ method: "initialized" });
          resolve();
        })
        .catch(reject);
    });
    this.#ready.catch(() => {
      this.#ready = null;
    });
    return this.#ready;
  }

  #write(msg: Json): void {
    this.#proc?.stdin.write(JSON.stringify(msg) + "\n");
  }

  #request(method: string, params: Json): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  #onLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) return this.#onServerRequest(msg);
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.#onNotification(msg.method, msg.params ?? {});
  }

  #onServerRequest(msg: Json): void {
    const params = msg.params ?? {};
    const run = this.#runsByThread.get(params.threadId);
    const known = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
    if (!run || !known.includes(msg.method)) {
      // Anything we can't route to the user is declined rather than left hanging.
      this.#write({ id: msg.id, error: { code: -32601, message: `unsupported request ${msg.method}` } });
      return;
    }
    const approvalId = randomUUID();
    this.#approvals.set(approvalId, { rpcId: msg.id, runId: run.runId });
    const kind = msg.method === "item/fileChange/requestApproval" ? "file_change" : "command";
    const summary =
      kind === "command" ? (params.command ?? params.reason ?? "执行命令") : (params.reason ?? "修改文件");
    this.#sink.event({
      type: "approval.requested",
      runId: run.runId,
      approvalId,
      kind,
      summary: String(summary).slice(0, 500),
      detail: params.cwd ? `cwd: ${params.cwd}` : undefined,
    });
  }

  #onNotification(method: string, p: Json): void {
    const run = p.threadId ? this.#runsByThread.get(p.threadId) : undefined;
    if (!run) return;
    const runId = run.runId;
    switch (method) {
      case "item/agentMessage/delta":
        this.#sink.event({ type: "message.delta", runId, messageId: p.itemId, text: p.delta });
        break;
      case "item/reasoning/summaryTextDelta":
        run.reasoning.set(p.itemId, (run.reasoning.get(p.itemId) ?? "") + p.delta);
        break;
      case "item/commandExecution/outputDelta": {
        const used = run.outputBytes.get(p.itemId) ?? 0;
        if (used >= MAX_TOOL_OUTPUT) break;
        const chunk = String(p.delta).slice(0, Math.min(MAX_CHUNK, MAX_TOOL_OUTPUT - used));
        run.outputBytes.set(p.itemId, used + chunk.length);
        this.#sink.event({ type: "tool.output", runId, callId: p.itemId, chunk });
        break;
      }
      case "item/started":
        if (p.item?.type !== "userMessage") run.active = true;
        this.#onItem(run, p.item, "started");
        break;
      case "item/completed":
        this.#onItem(run, p.item, "completed");
        // A finished tool call hands control back to the model: the next request starts now.
        if (TOOL_ITEMS.has(p.item?.type)) run.requestStart = Date.now();
        break;
      case "thread/tokenUsage/updated": {
        const last = p.tokenUsage?.last;
        // Resuming a thread re-reports the previous turn's last request; counting it again would double usage.
        if (last && run.active) {
          const now = Date.now();
          this.#sink.event({
            type: "usage",
            runId,
            model: run.model,
            inputTokens: last.inputTokens ?? 0,
            outputTokens: last.outputTokens ?? 0,
            cachedInputTokens: last.cachedInputTokens ?? undefined,
            reasoningTokens: last.reasoningOutputTokens ?? undefined,
            contextTokens: last.totalTokens ?? undefined,
            contextWindow: p.tokenUsage.modelContextWindow || undefined,
            durationMs: now - run.requestStart,
          });
          run.requestStart = now;
        }
        break;
      }
      case "error":
        if (!p.willRetry) run.lastError = p.error?.message;
        break;
      case "turn/completed": {
        const turn = p.turn ?? {};
        const status = turn.status === "completed" ? "done" : turn.status === "interrupted" ? "cancelled" : "failed";
        this.#finish(runId, status, status === "failed" ? (turn.error?.message ?? run.lastError) : undefined);
        break;
      }
    }
  }

  #onItem(run: ActiveRun, item: Json, phase: "started" | "completed"): void {
    const runId = run.runId;
    switch (item.type) {
      case "userMessage":
        return;
      case "agentMessage":
        if (phase === "completed") {
          this.#sink.event({ type: "message.completed", runId, messageId: item.id, text: item.text ?? "" });
        }
        return;
      case "reasoning": {
        if (phase !== "completed") return;
        const text = (item.summary?.length ? item.summary.join("\n") : run.reasoning.get(item.id)) ?? "";
        run.reasoning.delete(item.id);
        if (text.trim()) this.#sink.event({ type: "reasoning.summary", runId, text });
        return;
      }
      case "commandExecution":
        if (phase === "started") {
          this.#sink.event({ type: "tool.started", runId, callId: item.id, name: "shell", input: { command: item.command } });
        } else {
          this.#sink.event({
            type: "tool.completed",
            runId,
            callId: item.id,
            ok: item.status === "completed" && (item.exitCode ?? 0) === 0,
            result: { exitCode: item.exitCode, durationMs: item.durationMs },
            error: item.status === "declined" ? "用户拒绝" : undefined,
          });
          run.outputBytes.delete(item.id);
        }
        return;
      case "fileChange": {
        const files = (item.changes ?? []).map((c: Json) => c.path);
        if (phase === "started") {
          this.#sink.event({ type: "tool.started", runId, callId: item.id, name: "edit", input: { files } });
        } else {
          this.#sink.event({ type: "tool.completed", runId, callId: item.id, ok: item.status === "completed", result: { files } });
        }
        return;
      }
      case "mcpToolCall":
        if (phase === "started") {
          this.#sink.event({
            type: "tool.started",
            runId,
            callId: item.id,
            name: `${item.server}.${item.tool}`,
            input: item.arguments,
          });
        } else {
          this.#sink.event({
            type: "tool.completed",
            runId,
            callId: item.id,
            ok: !item.error,
            result: summarizeMcp(item.result),
            error: item.error?.message,
          });
        }
        return;
      default:
        if (phase === "started") {
          this.#sink.event({ type: "tool.started", runId, callId: item.id, name: String(item.type), input: compact(item) });
        } else {
          this.#sink.event({ type: "tool.completed", runId, callId: item.id, ok: true });
        }
    }
  }

  #finish(runId: string, status: "done" | "failed" | "cancelled", error?: string): void {
    const run = this.#runs.get(runId);
    if (!run) {
      this.#sink.done(runId, status, error);
      return;
    }
    this.#runs.delete(runId);
    this.#runsByThread.delete(run.threadId);
    for (const [id, a] of this.#approvals) if (a.runId === runId) this.#approvals.delete(id);
    this.#sink.done(runId, status, error);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** MCP results may carry base64 images; keep text and drop binary payloads from the event log. */
function summarizeMcp(result: Json | null): unknown {
  if (!result) return null;
  const content = (result.content ?? []).map((c: Json) =>
    c.type === "text" ? { type: "text", text: String(c.text).slice(0, 4000) } : { type: c.type },
  );
  return { content };
}

function compact(item: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === "id" || k === "type") continue;
    out[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  return out;
}
