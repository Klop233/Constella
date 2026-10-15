// Deterministic end-to-end of the streaming UI pipeline, with no Docker and no model: a recorded
// agent reply is fed to the hub's reader in the same chunks an engine would send, and the script
// prints the interface as it is built — the ops the hub emits, the tree after each batch, and the
// document it stores. Finally it rebuilds the tree from the emitted ops alone (exactly what the
// browser does) and checks the two sides agree, which is the invariant the whole feature rests on.
//
//   node --experimental-strip-types scripts/e2e/streamui-replay.mjs
import { docNodeCount, emptyDoc, isUiOp, migrateDoc, reduceOps } from "../../packages/protocol/src/streamui/doc.ts";
import { UiStreams, loadUiBlocks } from "../../apps/hub/src/streamui.ts";
import { openDb } from "../../apps/hub/src/db.ts";

const F = "```";
const REPLY = `三款都在 500 元以内：降噪最强的是小米，音质最均衡的是 Sony。

${F}ui-json 500 元内降噪耳机
{"op":"node","id":"root","type":"Col","children":[
{"type":"Caption","left":"500 元以内","right":"2026 年 3 月"},
{"type":"Grid","cols":3,"children":[
{"type":"Card","title":"小米 Buds 5 Pro","badge":"¥399","children":[{"type":"Text","text":"降噪 48dB，同价位最强"}]},
{"type":"Card","title":"Sony WF-C700N","badge":"¥499","children":[{"type":"Text","text":"音质均衡，佩戴轻"}]},
{"type":"Card","title":"OPPO Enco Air4 Pro","badge":"¥299","children":[{"type":"Text","text":"续航最长，降噪一般"}]}]},
{"type":"Chart","id":"price","props":{"type":"bar","data":[{"型号":"小米","价格":399},{"型号":"Sony","价格":499},{"型号":"OPPO","价格":299}],"x":"型号","y":["价格"],"format":"money","height":180}},
{"type":"Table","id":"rows","props":{"columns":["型号","降噪","续航","价格"],"rows":[]}},
{"type":"Loading","id":"wait","label":"正在核对续航数据","rows":2}]}
{"op":"data","id":"rows","props":{"rows":[["小米 Buds 5 Pro","48dB","38h","¥399"],["Sony WF-C700N","42dB","30h","¥499"],["OPPO Enco Air4 Pro","40dB","44h","¥299"]]}}
{"op":"remove","id":"wait"}
{"op":"node","id":"pick","type":"Button","label":"就选这个","props":{"variant":"primary","send":"就选这个"}}
{"op":"done"}
${F}

需要的话，我可以按你的手机型号再筛一遍。`;

const runId = "run-replay";
const messageId = "um-replay";

/** The hub's reader, wired to a throwaway database and a fake event sink. */
const db = openDb(":memory:");
const emitted = [];
const ui = new UiStreams(db, { append: (_agentId, _conversationId, event) => (emitted.push(event), event) });
const run = { id: runId, agent_id: "ag-replay", conversation_id: "cv-replay" };

/** Feeds the reply in small chunks, the way an engine streams a message. */
function chunk(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const browser = new Map();
const applyBrowser = (event) => {
  const doc = browser.get(event.blockId) ?? emptyDoc();
  browser.set(event.blockId, reduceOps(doc, event.ops.map((op, i) => ({ seq: event.from + i, op }))));
};

console.log("▶ 模型边写，hub 边读；下面是它发出去的 ui.op 事件（浏览器就是照这些画的）\n");
for (const piece of chunk(REPLY, 90)) {
  const before = emitted.length;
  ui.onText(run, messageId, piece, false);
  for (const event of emitted.slice(before)) {
    if (event.type === "ui.op") {
      applyBrowser(event);
      const doc = browser.get(event.blockId);
      console.log(`  ui.op  block ${event.blockId} · ops ${event.from}–${event.from + event.ops.length - 1} · 组件 ${docNodeCount(doc)}`);
    } else if (event.type === "ui.state") {
      console.log(`  ui.state block ${event.blockId} · ${event.status} · 组件 ${event.nodes} · 指令 ${event.ops}${event.issues.length ? ` · 诊断 ${event.issues.join("；")}` : ""}`);
    }
  }
}
ui.onText(run, messageId, REPLY, true);

const finals = emitted.filter((e) => e.type === "ui.state");
const last = finals.at(-1);
console.log(`\n▶ 结束：${last.status} · ${last.nodes} 个组件 · ${last.ops} 条指令`);

/** The tree, as a text preview (the same shape the browser renders). */
function tree(doc, id, depth, out) {
  const node = doc.nodes[id];
  if (!node || depth > 12) return out;
  const text = typeof node.props.text === "string" ? ` "${node.props.text.slice(0, 30)}"` : "";
  const extra = node.type === "Table" ? ` (${(node.props.rows ?? []).length} 行)` : node.type === "Chart" ? ` (${(node.props.data ?? []).length} 点)` : "";
  out.push(`${"  ".repeat(depth)}${node.type} #${id}${text}${extra}`);
  for (const child of node.children) if (typeof child === "string") tree(doc, child, depth + 1, out);
  return out;
}

const stored = loadUiBlocks(db, messageId);
console.log(`\n▶ 服务端存下的文档：${stored.length} 块`);
for (const block of stored) {
  console.log(`\n  block ${block.blockId}「${block.title}」${block.status}`);
  for (const root of block.doc.roots) {
    if (typeof root === "string") for (const line of tree(block.doc, root, 1, [])) console.log(`  ${line}`);
    else console.log(`  （文字）${root.text.slice(0, 40)}`);
  }
}

// The invariant: the browser's tree and the stored document must be the same interface.
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};
const storedDoc = stored[0]?.doc;
const browserDoc = browser.get("0");
check(stored.length === 1, "一个块被存下来");
check(!!storedDoc && !!browserDoc, "两边都建出了文档");
check(storedDoc && browserDoc && docNodeCount(storedDoc) === docNodeCount(browserDoc), `两边组件数一致（${storedDoc ? docNodeCount(storedDoc) : "-"}）`);
check(
  storedDoc && browserDoc && JSON.stringify(storedDoc.nodes) === JSON.stringify(browserDoc.nodes),
  "两边的状态树逐字节一致",
);
check(storedDoc?.status === "done", "文档状态是 done");
check((storedDoc?.issues.length ?? -1) === 0, "没有诊断");
check(!storedDoc?.nodes["wait"], "Loading 占位在数据到齐后被删掉了");
check((storedDoc?.nodes["rows"]?.props.rows ?? []).length === 3, "表格的 3 行数据补上了");
check(storedDoc?.nodes["pick"]?.type === "Button", "第二个根节点（按钮）建出来了");
check(JSON.stringify(storedDoc?.nodes["pick"]?.props.send) === JSON.stringify("就选这个"), "按钮带着声明式的 send（浏览器把它接到 Action Dispatcher 上）");
check(migrateDoc(JSON.parse(JSON.stringify(storedDoc))) !== null, "存下来的文档能被重新读回（刷新/重开对话）");

// Ops are numbered 1..n with no gaps: a gap would leave the browser waiting forever.
const opEvents = emitted.filter((e) => e.type === "ui.op");
const seqs = opEvents.flatMap((e) => e.ops.map((_, i) => e.from + i));
check(seqs.length > 0 && seqs.every((s, i) => s === i + 1), `ui.op 的序号从 1 连续到 ${seqs.length}`);
check(
  emitted.filter((e) => e.type === "ui.op").every((e) => e.ops.every(isUiOp)),
  "发出去的每条指令都是合法形状",
);

console.log(failures ? `\n${failures} 项不符合预期` : "\n全部符合预期");
process.exit(failures ? 1 : 0);
