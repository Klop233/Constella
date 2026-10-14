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
/** The open connection used for sending, and the one being connected or open (a replaced socket's events are ignored). */
let ws: WebSocket | null = null;
let current: WebSocket | null = null;
/** The hub pings every 30 s; this long without a word means the connection is dead even if TCP hasn't noticed. */
const SILENT_MS = 90_000;
let lastHeard = Date.now();

function send(msg: RunnerToHub): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else outbox.push(msg);
}

const engine = new CodexEngine({
  event: (event) => send({ t: "event", event }),
  thread: (runId, threadId) => send({ t: "thread", runId, threadId }),
  done: (runId, status, error) => send({ t: "turn_done", runId, status, ...(error ? { error } : {}) }),
  // A heartbeat is only useful live; don't replay stale ones after a reconnect.
  activity: (runId) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "activity", runId } satisfies RunnerToHub));
  },
});

async function handle(msg: HubToRunner): Promise<void> {
  switch (msg.t) {
    case "start":
      return engine.start(msg);
    case "steer":
      return engine.steer(msg.runId, msg.text, msg.images);
    case "interrupt":
      return engine.interrupt(msg.runId);
    case "approval_decision":
      return engine.resolveApproval(msg.approvalId, msg.decision);
    case "ping":
      return send({ t: "pong" });
  }
}

/** Tell the hub which reasoning levels each model supports; asked from Codex once per process. */
let models: Promise<Extract<RunnerToHub, { t: "models" }>["models"]> | null = null;
function reportModels(): void {
  models ??= engine.models();
  models.then(
    (list) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "models", models: list })),
    (err) => {
      models = null;
      console.error("model list failed", err);
    },
  );
}

function connect(delay = 1000): void {
  const sock = new WebSocket(`${HUB_URL}?agent=${encodeURIComponent(AGENT_ID)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  } as any);
  current = sock;
  sock.addEventListener("open", () => {
    if (current !== sock) return sock.close();
    ws = sock;
    lastHeard = Date.now();
    console.log(`connected to hub ${HUB_URL}`);
    sock.send(JSON.stringify({ t: "hello", agentId: AGENT_ID, version: VERSION, activeRuns: engine.activeRunIds() }));
    while (outbox.length && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(outbox.shift()));
    delay = 1000;
    reportModels();
  });
  sock.addEventListener("message", (e) => {
    lastHeard = Date.now();
    let msg: HubToRunner;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    handle(msg).catch((err) => console.error("handler error", err));
  });
  let retried = false;
  const retry = () => {
    // Once per socket, and not for one replaced after going silent (a new connection is already underway).
    if (retried || current !== sock) return;
    retried = true;
    current = null;
    if (ws === sock) ws = null;
    setTimeout(() => connect(Math.min(delay * 2, 15000)), delay);
  };
  sock.addEventListener("close", retry);
  sock.addEventListener("error", (e) => {
    console.error(`hub connection error: ${(e as { message?: string }).message ?? "unknown"}`);
    // A failed handshake (hub restarting) fires "error" but never "close", so retry from here. Calling
    // close() instead re-fires "error" and recurses until the stack overflows, killing the runner and its runs.
    if (sock.readyState !== WebSocket.OPEN) retry();
  });
}

// A connection that went quiet (network cut, hub frozen) is dropped and replaced; runs keep going meanwhile.
setInterval(() => {
  const sock = ws;
  if (!sock || Date.now() - lastHeard < SILENT_MS) return;
  console.error(`no word from the hub for ${Math.round((Date.now() - lastHeard) / 1000)} s; reconnecting`);
  ws = null;
  current = null;
  try {
    sock.close();
  } catch {}
  connect();
}, 15_000);

process.on("SIGTERM", () => {
  engine.stop();
  process.exit(0);
});

connect();
