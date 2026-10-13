import type { HubToRunner, RunnerToHub } from "@constella/protocol";
import { CodexEngine } from "./engines/codex.ts";

const HUB_URL = process.env.CONSTELLA_HUB_WS ?? "ws://constella-hub:8780/api/runner";
const AGENT_ID = required("CONSTELLA_AGENT_ID");
const TOKEN = required("CONSTELLA_AGENT_TOKEN");
const VERSION = "0.1.0";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return v;
}

/** Messages produced while disconnected are queued and flushed on reconnect so no event is lost. */
const outbox: RunnerToHub[] = [];
let ws: WebSocket | null = null;

function send(msg: RunnerToHub): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else outbox.push(msg);
}

const engine = new CodexEngine({
  event: (event) => send({ t: "event", event }),
  thread: (runId, threadId) => send({ t: "thread", runId, threadId }),
  done: (runId, status, error) => send({ t: "turn_done", runId, status, ...(error ? { error } : {}) }),
});

async function handle(msg: HubToRunner): Promise<void> {
  switch (msg.t) {
    case "start":
      return engine.start(msg);
    case "steer":
      return engine.steer(msg.runId, msg.text);
    case "interrupt":
      return engine.interrupt(msg.runId);
    case "approval_decision":
      return engine.resolveApproval(msg.approvalId, msg.decision);
    case "ping":
      return send({ t: "pong" });
  }
}

function connect(delay = 1000): void {
  const sock = new WebSocket(`${HUB_URL}?agent=${encodeURIComponent(AGENT_ID)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  } as any);
  sock.addEventListener("open", () => {
    ws = sock;
    console.log(`connected to hub ${HUB_URL}`);
    sock.send(JSON.stringify({ t: "hello", agentId: AGENT_ID, version: VERSION, activeRuns: engine.activeRunIds() }));
    while (outbox.length && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(outbox.shift()));
    delay = 1000;
  });
  sock.addEventListener("message", (e) => {
    let msg: HubToRunner;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    handle(msg).catch((err) => console.error("handler error", err));
  });
  sock.addEventListener("close", () => {
    if (ws === sock) ws = null;
    setTimeout(() => connect(Math.min(delay * 2, 15000)), delay);
  });
  sock.addEventListener("error", () => sock.close());
}

process.on("SIGTERM", () => {
  engine.stop();
  process.exit(0);
});

connect();
