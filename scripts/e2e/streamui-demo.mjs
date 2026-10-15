// Live demo of the streaming UI DSL against a running hub: send a prompt, watch the interface being
// built op by op as the model writes it, then read back the stored document.
//
//   HUB=http://127.0.0.1:8790 node --experimental-strip-types scripts/e2e/streamui-demo.mjs [prompt]
//
// Exits non-zero when no ui-json block arrived, so it can be used as a check, not just a demo.
import { docNodeCount, emptyDoc, reduceOps } from "../../packages/protocol/src/streamui/doc.ts";

const HUB = process.env.HUB ?? "http://127.0.0.1:8790";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300_000);
const PROMPT =
  process.argv.slice(2).join(" ").trim() ||
  "用界面帮我比较三款 500 元以内的降噪耳机（价格、降噪、续航、音质），给一个柱状图和一个表格，最后放一个按钮，文字是「就选这个」，点了之后把「就选这个」这句话发给我。";

const json = { "content-type": "application/json", "x-constella": "1" };
const log = (...a) => console.log(...a);
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

const overview = await (await fetch(`${HUB}/api/overview`)).json();
const agent = (overview.agents ?? []).find((a) => !a.archived) ?? overview.agents?.[0];
if (!agent) {
  console.error("no agent configured on this hub");
  process.exit(2);
}
log(`▶ agent ${agent.name} (${agent.id}) · hub ${HUB}`);

/** One block being streamed, rebuilt with the same reducer the browser uses. */
const blocks = new Map();
let runId = null;
let conversationId = null;
let messageId = null;
let lastPrinted = new Map();

function preview(doc, id, depth, out) {
  const node = doc.nodes[id];
  if (!node || depth > 12) return out;
  const text = typeof node.props.text === "string" ? ` "${node.props.text.slice(0, 34)}"` : "";
  out.push(`${"  ".repeat(depth)}${node.type} #${id}${text}`);
  for (const child of node.children) if (typeof child === "string") preview(doc, child, depth + 1, out);
  return out;
}

function onEvent(event) {
  if (event.runId !== runId) return;
  if (event.type === "message.delta") {
    messageId = event.messageId;
    return;
  }
  if (event.type === "message.completed") {
    messageId = event.messageId;
    return;
  }
  if (event.type === "ui.op") {
    const key = event.blockId;
    const doc = reduceOps(blocks.get(key) ?? emptyDoc(), event.ops.map((op, i) => ({ seq: event.from + i, op })));
    blocks.set(key, doc);
    const shown = lastPrinted.get(key) ?? 0;
    const count = docNodeCount(doc);
    log(`  ← ui.op  block ${key} · ops ${event.from}–${event.from + event.ops.length - 1} · ${count} 个组件（+${count - shown}）`);
    if (count > shown) {
      for (const line of preview(doc, doc.roots.find((r) => typeof r === "string") ?? "", 0, [])) log(`      ${line}`);
      lastPrinted.set(key, count);
    }
    return;
  }
  if (event.type === "ui.state") {
    log(`  ← ui.state block ${event.blockId} · ${event.status} · ${event.nodes} 个组件 · ${event.ops} 条指令${event.issues.length ? ` · 诊断 ${event.issues.join("；")}` : ""}`);
    return;
  }
  if (event.type === "run.status" && ["done", "failed", "cancelled"].includes(event.status)) {
    log(`▶ run ${event.status}${event.error ? `：${event.error}` : ""}`);
    stop();
  }
}

// One SSE connection for the whole run, exactly like the PWA's lib/live.ts.
const stream = await fetch(`${HUB}/api/stream`, { headers: { accept: "text/event-stream" } });
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let stop = () => {};
const done = new Promise((resolve) => {
  stop = resolve;
});

const pump = (async () => {
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const name = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (name !== "agent" || !data) continue;
      try {
        onEvent(JSON.parse(data).event);
      } catch {
        // a half-written frame: the next read completes it
      }
    }
  }
})();

const started = await (await fetch(`${HUB}/api/agents/${agent.id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: PROMPT }) })).json();
if (!started.runId) {
  console.error("could not start a run:", JSON.stringify(started));
  process.exit(2);
}
runId = started.runId;
conversationId = started.conversationId;
log(`▶ run ${runId} started · 提示：${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? "…" : ""}`);
log("▶ 下面是界面被一条条指令搭起来的过程（浏览器的渲染顺序与此完全一致）");

await Promise.race([done, new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS))]);
await pump.catch(() => {});

log("");
if (!blocks.size) {
  fail("这个回复里没有 ui-json 界面（检查智能界面设置和给 agent 的说明）");
} else {
  for (const [key, doc] of blocks) {
    log(`✓ block ${key}：${docNodeCount(doc)} 个组件，${doc.ops} 条指令，状态 ${doc.status}`);
    if (doc.issues.length) log(`  诊断：${doc.issues.join("；")}`);
  }
  if (messageId) {
    const stored = await (await fetch(`${HUB}/api/messages/${messageId}/ui`)).json();
    log(`✓ 服务端保存的快照：${stored.blocks?.length ?? 0} 块（刷新页面/重开历史对话时用它恢复）`);
    for (const block of stored.blocks ?? []) log(`  · block ${block.blockId}「${block.title}」${block.status} · ${docNodeCount(block.doc)} 个组件 · v${block.doc.v}`);
  }
}
log(`\n对话：${HUB}/c/${conversationId}`);
