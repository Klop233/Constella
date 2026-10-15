import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UI_DOC_VERSION, UI_JSON_LANG, UI_LIMITS, docNodeCount, emptyDoc, migrateDoc, normalizeAction, reduceOps, safeUrl,
  scanJsonValues, splitWidgets, uiJsonBlocks, validateProps, type RunnerEvent, type UIDoc,
} from "@constella/protocol";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.ts";
import type { EventStore } from "../src/events.ts";

// The streaming UI DSL (```ui-json replies): reading JSON out of a reply that is still being written,
// the reducer that builds the state tree from ops, the action/URL whitelists, and the hub side that
// turns a streaming reply into `ui.op` events plus one stored document. The reducer is shared by the
// hub and the browser, so its boundary cases are pinned down here, where the unit tests live.
// Anything importing apps/hub/src/* runs against a throwaway data dir (see the guard below).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-streamui-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const { config } = await import("../src/config.ts");
if (config.dataDir !== tmp) throw new Error(`test data dir leaked to ${config.dataDir}; refusing to run against real data`);
const { openDb } = await import("../src/db.ts");
const { UiStreams, loadUiBlocks } = await import("../src/streamui.ts");

// ── helpers ──────────────────────────────────────────────

/** Feeds ops to the reducer with consecutive seq numbers, the way the hub numbers them (from 1). */
function feeder(start: UIDoc = emptyDoc()) {
  let doc = start;
  let seq = start.seq;
  return {
    get doc(): UIDoc {
      return doc;
    },
    push(...ops: unknown[]): UIDoc {
      doc = reduceOps(
        doc,
        ops.map((op) => ({ seq: ++seq, op })),
      );
      return doc;
    },
    /** Sends an op at the index already applied (a partial reading being revised). */
    revise(...ops: unknown[]): UIDoc {
      doc = reduceOps(
        doc,
        ops.map((op) => ({ seq, op })),
      );
      return doc;
    },
  };
}

/** A ```ui-json fence around `body`; `closed: false` leaves it still being streamed. */
function uiJsonBlock(title: string, body: string, closed = true): string {
  return "```" + UI_JSON_LANG + (title ? ` ${title}` : "") + "\n" + body + (closed ? "\n```" : "");
}

/** The smallest db that accepts the upsert UiStreams writes. */
function fakeDb() {
  const rows: unknown[][] = [];
  const db = { prepare: () => ({ run: (...args: unknown[]) => void rows.push(args) }) };
  return { rows, db: db as unknown as Db };
}

/** The smallest EventStore: records what the hub emitted. */
function fakeStore() {
  const events: RunnerEvent[] = [];
  const store = {
    append: (_agentId: string, _conversationId: string, ev: RunnerEvent) => {
      events.push(ev);
      return ev;
    },
  };
  return { events, store: store as unknown as EventStore };
}

interface UiOpEvent {
  type: "ui.op";
  runId: string;
  messageId: string;
  blockId: string;
  from: number;
  ops: { op: string }[];
}

interface UiStateEvent {
  type: "ui.state";
  runId: string;
  messageId: string;
  blockId: string;
  status: string;
  nodes: number;
  ops: number;
  issues: string[];
}

const opEvents = (events: RunnerEvent[]): UiOpEvent[] => events.filter((e) => e.type === "ui.op") as unknown as UiOpEvent[];
const stateEvents = (events: RunnerEvent[]): UiStateEvent[] => events.filter((e) => e.type === "ui.state") as unknown as UiStateEvent[];

const hasIssue = (doc: UIDoc, needle: string): boolean => doc.issues.some((i) => i.includes(needle));

// ── A. reading the stream ────────────────────────────────

describe("scanJsonValues", () => {
  it("reads one object per line, a pretty-printed object, or an array of ops", () => {
    const lines = '{"op":"node","id":"a"}\n{"op":"node","id":"b"}\n';
    const perLine = scanJsonValues(lines);
    expect(perLine.values).toEqual([{ op: "node", id: "a" }, { op: "node", id: "b" }]);
    expect(perLine.bad).toBe(0);
    expect(perLine.next).toBe(lines.length);

    const pretty = scanJsonValues('{\n  "op": "node",\n  "id": "root",\n  "type": "Col"\n}\n');
    expect(pretty.values).toEqual([{ op: "node", id: "root", type: "Col" }]);
    expect(pretty.bad).toBe(0);

    const array = scanJsonValues('[{"op":"node","id":"a"},{"op":"node","id":"b"}]');
    expect(array.values).toEqual([{ op: "node", id: "a" }, { op: "node", id: "b" }]);
  });
  it("reads a value that is still being written as far as it has got, and revises it later", () => {
    const head = '{"op":"node","id":"a"}\n{"op":"node","id":"b"';
    const first = scanJsonValues(head);
    // The unfinished op is read as far as it has got, and `next` still points at it so the next chunk
    // revises it instead of starting a new op — this is what makes a big op render as it is typed.
    expect(first.values).toEqual([{ op: "node", id: "a" }, { op: "node", id: "b" }]);
    expect(first.open).toBe(true);
    expect(head.slice(first.next)).toBe('{"op":"node","id":"b"');

    const rest = scanJsonValues(head + ',"type":"Col"}', first.next);
    expect(rest.values).toEqual([{ op: "node", id: "b", type: "Col" }]);
    expect(rest.open).toBe(false);
    expect(rest.bad).toBe(0);
  });
  it("salvages a whole tree that is still being written, element by element", () => {
    const full = '{"op":"node","id":"root","type":"Col","children":[{"type":"Text","text":"一"},{"type":"Text","text":"二"},{"type":"Text","text":"三"}]}';
    const seen: number[] = [];
    for (let cut = 1; cut <= full.length; cut++) {
      const scan = scanJsonValues(full.slice(0, cut));
      const last = scan.values.at(-1) as { children?: unknown[] } | undefined;
      seen.push(last?.children?.length ?? 0);
    }
    // The number of children the reader can see never goes backwards, and it gets all the way there.
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)).toBe(3);
    // A prefix that stops inside the third child still shows the first two, plus what of the third has
    // been typed — which is exactly what makes the interface appear while the model is writing.
    const mid = full.indexOf('"三"');
    const partial = scanJsonValues(full.slice(0, mid));
    expect(partial.open).toBe(true);
    const kids = (partial.values.at(-1) as { children: { type: string; text?: string }[] }).children;
    expect(kids).toHaveLength(3);
    expect(kids[0]).toEqual({ type: "Text", text: "一" });
    expect(kids[1]).toEqual({ type: "Text", text: "二" });
    expect(kids[2]).toEqual({ type: "Text" });
  });
  it("is not confused by braces inside strings, and counts garbage as bad", () => {
    const value = { op: "node", id: "t", text: 'a } [ b " { c' };
    expect(scanJsonValues(JSON.stringify(value)).values).toEqual([value]);

    const { values, bad } = scanJsonValues('oops\n{"op":"node","id":"a"}\nnope {"op":"node","id":"b"}');
    expect(bad).toBe(2);
    expect(values).toEqual([{ op: "node", id: "a" }, { op: "node", id: "b" }]);
  });
  it("skips a stray closing bracket instead of losing the rest of the block", () => {
    // A duplicated or truncated op used to park the cursor here for good, silently dropping every
    // later op; the whole reply would stop growing with nothing to show for it.
    const text = '{"op":"node","id":"a"}\n}\n{"op":"node","id":"b"}\n]\n{"op":"node","id":"c"}';
    const scan = scanJsonValues(text);
    expect(scan.values).toEqual([{ op: "node", id: "a" }, { op: "node", id: "b" }, { op: "node", id: "c" }]);
    expect(scan.bad).toBe(2);
    expect(scan.next).toBe(text.length);
  });
});

describe("ui-json blocks", () => {
  it("marks a ```ui-json block as json and returns its source and title", () => {
    const text = "先看结果。\n" + uiJsonBlock("房贷", '{"op":"node","id":"root"}');
    const ui = splitWidgets(text).filter((p) => p.kind === "ui");
    expect(ui).toHaveLength(1);
    expect(ui[0]).toEqual({ kind: "ui", title: "房贷", source: '{"op":"node","id":"root"}', closed: true, format: "json" });
    expect(uiJsonBlocks(text)).toEqual([{ index: 0, title: "房贷", source: '{"op":"node","id":"root"}', closed: true }]);
    expect(UI_JSON_LANG).toBe("ui-json");
  });
  it("reports a still-open fence as not closed", () => {
    const text = uiJsonBlock("图表", '{"op":"node","id":"root"}', false);
    expect(uiJsonBlocks(text)).toEqual([{ index: 0, title: "图表", source: '{"op":"node","id":"root"}', closed: false }]);
  });
  it("leaves a ```ui component block out of uiJsonBlocks but still counts it", () => {
    const text = "```ui 计算器\n<Card/>\n```\n" + uiJsonBlock("表格", '{"op":"node","id":"root","type":"Col"}');
    const ui = splitWidgets(text).filter((p) => p.kind === "ui");
    expect(ui.map((p) => p.format)).toEqual(["components", "json"]);
    expect(uiJsonBlocks(text)).toEqual([{ index: 1, title: "表格", source: '{"op":"node","id":"root","type":"Col"}', closed: true }]);
  });
});

// ── B. the reducer: building a tree ──────────────────────

describe("reduceOps: building a tree", () => {
  it("creates nodes, appends children and nests them", () => {
    const f = feeder();
    f.push({ op: "node", id: "root", type: "Col" });
    f.push({ op: "append", parent: "root", child: { id: "card", type: "Card", props: { title: "卡片" } } });
    f.push({ op: "append", parent: "card", child: { id: "txt", type: "Text", text: "你好" } });

    expect(f.doc.roots).toEqual(["root"]);
    expect(docNodeCount(f.doc)).toBe(3);
    expect(f.doc.nodes["root"]!.children).toEqual(["card"]);
    expect(f.doc.nodes["card"]!.parent).toBe("root");
    expect(f.doc.nodes["card"]!.children).toEqual(["txt"]);
    expect(f.doc.nodes["txt"]!.parent).toBe("card");
    expect(f.doc.nodes["txt"]!.props.text).toBe("你好");
    expect(f.doc.status).toBe("streaming");
    expect(f.doc.issues).toEqual([]);
  });
  it("creates inline children and gives them ids", () => {
    const doc = feeder().push({ op: "node", id: "root", type: "Col", children: [{ type: "Text", text: "一" }, { id: "b", type: "Card" }] });
    expect(doc.nodes["root"]!.children).toEqual(["root.0", "b"]);
    expect(doc.nodes["root.0"]!.type).toBe("Text");
    expect(doc.nodes["root.0"]!.props.text).toBe("一");
    expect(doc.nodes["b"]!.type).toBe("Card");
    expect(docNodeCount(doc)).toBe(3);
  });
  it("collects props written next to id and type, including a bare text", () => {
    const heading = feeder().push({ op: "node", id: "h", type: "Heading", text: "标题" });
    expect(heading.nodes["h"]!.props.text).toBe("标题");
    const stat = feeder().push({ op: "node", id: "s", type: "Stat", label: "a", value: 1 });
    expect(stat.nodes["s"]!.props).toMatchObject({ label: "a", value: "1" });
  });
  it("keeps a node of an unknown type and records an issue instead of throwing", () => {
    const f = feeder();
    expect(() => f.push({ op: "node", id: "x", type: "Frobnicator" })).not.toThrow();
    expect(f.doc.nodes["x"]!.type).toBe("Frobnicator");
    expect(f.doc.nodes["x"]!.props).toEqual({});
    expect(hasIssue(f.doc, "Frobnicator")).toBe(true);
  });
  it("drops unknown and wrongly typed props but keeps a coercible one", () => {
    const f = feeder();
    f.push({ op: "node", id: "t", type: "Text", props: { bogus: 1, bold: "yes", truncate: "true" } });
    const props = f.doc.nodes["t"]!.props;
    expect(props.bogus).toBeUndefined();
    expect(props.bold).toBeUndefined();
    expect(props.truncate).toBe(true); // "true" → true
    expect(hasIssue(f.doc, "bogus")).toBe(true);
    expect(hasIssue(f.doc, "bold")).toBe(true);

    const doc = feeder().push({ op: "node", id: "p", type: "Progress", props: { value: "3" } });
    expect(doc.nodes["p"]!.props.value).toBe(3); // "3" → 3
  });
  it("drops an enum prop outside its allowed values", () => {
    const doc = feeder().push({ op: "node", id: "t", type: "Text", props: { size: "huge" } });
    expect(doc.nodes["t"]!.props.size).toBeUndefined();
    expect(hasIssue(doc, "size")).toBe(true);
  });
  it("normalizes action props and drops a bogus one", () => {
    const f = feeder();
    f.push({ op: "node", id: "a", type: "Card", props: { onClick: "去做" } });
    f.push({ op: "node", id: "b", type: "Card", props: { onClick: { send: "发这个" } } });
    f.push({ op: "node", id: "c", type: "Card", props: { onClick: { type: "copy", text: "复制我" } } });
    f.push({ op: "node", id: "d", type: "Card", props: { onClick: { type: "launch" } } });
    expect(f.doc.nodes["a"]!.props.onClick).toEqual({ type: "send", text: "去做" });
    expect(f.doc.nodes["b"]!.props.onClick).toEqual({ type: "send", text: "发这个" });
    expect(f.doc.nodes["c"]!.props.onClick).toEqual({ type: "copy", text: "复制我" });
    expect(f.doc.nodes["d"]!.props.onClick).toBeUndefined();
    expect(hasIssue(f.doc, "onClick")).toBe(true);
  });
  it("merges on update and replaces with replace:true", () => {
    const f = feeder();
    f.push({ op: "node", id: "s", type: "Stat", props: { label: "总量", value: "1" } });
    f.push({ op: "update", id: "s", props: { value: "2" } });
    expect(f.doc.nodes["s"]!.props).toMatchObject({ label: "总量", value: "2" });

    f.push({ op: "update", id: "s", props: { value: "9" }, replace: true });
    expect(f.doc.nodes["s"]!.props).toEqual({ value: "9" });
  });
  it("removes a subtree and unlinks it from its parent", () => {
    const f = feeder();
    f.push({ op: "node", id: "a", type: "Col" });
    f.push({ op: "node", id: "b", type: "Text", parent: "a" });
    f.push({ op: "remove", id: "a" });
    expect(f.doc.nodes["a"]).toBeUndefined();
    expect(f.doc.nodes["b"]).toBeUndefined();
    expect(f.doc.roots).toEqual([]);
  });
  it("removes a nested subtree and lets its parent go", () => {
    const f = feeder();
    f.push({ op: "node", id: "root", type: "Col" });
    f.push({ op: "node", id: "card", type: "Card", parent: "root" });
    f.push({ op: "node", id: "txt", type: "Text", parent: "card" });
    f.push({ op: "remove", id: "card" });
    expect(f.doc.nodes["card"]).toBeUndefined();
    expect(f.doc.nodes["txt"]).toBeUndefined();
    // The parent must not keep a dead id: it would render as a permanent Loading placeholder.
    expect(f.doc.nodes["root"]!.children).toEqual([]);
  });
  it("moves a node instead of leaving it reachable from two places", () => {
    const f = feeder();
    f.push({ op: "node", id: "root", type: "Col" });
    f.push({ op: "node", id: "solo", type: "Text", text: "孤零零" });
    expect(f.doc.roots).toEqual(["root", "solo"]);
    f.push({ op: "append", parent: "root", child: "solo" });
    expect(f.doc.roots).toEqual(["root"]);
    expect(f.doc.nodes["root"]!.children).toEqual(["solo"]);
    expect(f.doc.nodes["solo"]!.parent).toBe("root");
  });
  it("replaces children and prunes what is no longer reachable", () => {
    const f = feeder();
    f.push({ op: "node", id: "root", type: "Col" });
    f.push({ op: "append", parent: "root", child: { id: "a", type: "Text", text: "一" } });
    f.push({ op: "append", parent: "root", child: { id: "b", type: "Text", text: "二" } });
    expect(f.doc.nodes["root"]!.children).toEqual(["a", "b"]);

    f.push({ op: "replace", parent: "root", children: [{ id: "c", type: "Text", text: "三" }] });
    expect(f.doc.nodes["root"]!.children).toEqual(["c"]);
    expect(f.doc.nodes["a"]).toBeUndefined();
    expect(f.doc.nodes["b"]).toBeUndefined();
    expect(f.doc.nodes["c"]!.props.text).toBe("三");
    expect(docNodeCount(f.doc)).toBe(2);
  });
  it("sets props.text from a text op and treats a data op like an update", () => {
    const f = feeder();
    f.push({ op: "node", id: "t", type: "Text" });
    f.push({ op: "text", id: "t", text: "改过了" });
    expect(f.doc.nodes["t"]!.props.text).toBe("改过了");

    f.push({ op: "node", id: "s", type: "Stat", props: { label: "总量", value: "1" } });
    f.push({ op: "data", id: "s", props: { value: "7" } });
    expect(f.doc.nodes["s"]!.props).toMatchObject({ label: "总量", value: "7" });
  });
});

describe("validateProps", () => {
  it("returns null for an unregistered component", () => {
    const issues: string[] = [];
    expect(validateProps("Frobnicator", {}, "x", issues)).toBeNull();
    expect(issues[0]).toContain("Frobnicator");
  });
  it("keeps what it can and reports a missing required prop", () => {
    const issues: string[] = [];
    expect(validateProps("Stat", { label: "a" }, "s", issues)).toEqual({ label: "a" });
    expect(issues.some((i) => i.includes("value"))).toBe(true);
  });
});

// ── C. robustness at the boundaries ──────────────────────

describe("reduceOps: stream boundaries", () => {
  it("grows an op that is still being written instead of waiting for it to finish", () => {
    const f = feeder();
    const reading = (texts: string[]) => ({ op: "node", id: "root", type: "Col", partial: true, children: texts.map((text) => ({ type: "Text", text })) });
    f.push(reading(["一"]));
    expect(f.doc.seq).toBe(1);
    expect(docNodeCount(f.doc)).toBe(2);

    // The same index again with more of the op: the tree grows in place, it doesn't become a second tree.
    f.revise(reading(["一", "二"]));
    expect(f.doc.seq).toBe(1);
    expect(f.doc.nodes["root"]!.children).toHaveLength(2);
    expect(docNodeCount(f.doc)).toBe(3);

    // The finished op lands on the same index and replaces the reading, so nothing from it lingers.
    f.revise({ op: "node", id: "root", type: "Col", children: [{ type: "Text", text: "一" }] });
    expect(f.doc.seq).toBe(1);
    expect(f.doc.partial).toBe(false);
    expect(f.doc.nodes["root"]!.children).toHaveLength(1);
    expect(docNodeCount(f.doc)).toBe(2);

    // A later op still gets its own index.
    f.push({ op: "node", id: "foot", type: "Caption" });
    expect(f.doc.seq).toBe(2);
    expect(f.doc.roots).toHaveLength(2);
  });
  it("applies a duplicate op (same seq twice) only once", () => {
    const op = { op: "node", id: "a", type: "Col" };
    let doc = reduceOps(emptyDoc(), [
      { seq: 1, op },
      { seq: 1, op },
    ]);
    expect(doc.ops).toBe(1);
    expect(docNodeCount(doc)).toBe(1);

    // A replayed stream is ignored entirely, and a second write of the same seq never adds a node.
    doc = reduceOps(doc, [{ seq: 1, op }]);
    expect(doc.ops).toBe(1);
    const other = reduceOps(emptyDoc(), [
      { seq: 1, op },
      { seq: 1, op: { op: "node", id: "b", type: "Col" } },
    ]);
    expect(docNodeCount(other)).toBe(1);
    expect(other.nodes["b"]).toBeDefined();
  });
  it("buffers an out-of-order op and applies it in order once the gap fills", () => {
    let doc = reduceOps(emptyDoc(), [{ seq: 1, op: { op: "node", id: "t", type: "Text" } }]);
    doc = reduceOps(doc, [{ seq: 3, op: { op: "text", id: "t", text: "第三" } }]);
    expect(doc.seq).toBe(1);
    expect(Object.keys(doc.pending)).toEqual(["3"]);
    expect(doc.nodes["t"]!.props.text).toBeUndefined();

    doc = reduceOps(doc, [{ seq: 2, op: { op: "text", id: "t", text: "第二" } }]);
    expect(doc.seq).toBe(3);
    expect(doc.pending).toEqual({});
    expect(doc.nodes["t"]!.props.text).toBe("第三"); // 2 was applied before 3
  });
  it("keeps later ops buffered when the gap never fills, without throwing", () => {
    let doc = reduceOps(emptyDoc(), [{ seq: 1, op: { op: "node", id: "root", type: "Col" } }]);
    expect(() => {
      doc = reduceOps(doc, [
        { seq: 5, op: { op: "node", id: "x", type: "Text", parent: "root" } },
        { seq: 6, op: { op: "node", id: "y", type: "Text", parent: "root" } },
      ]);
    }).not.toThrow();
    expect(doc.seq).toBe(1);
    expect(Object.keys(doc.pending).sort()).toEqual(["5", "6"]);
    expect(docNodeCount(doc)).toBe(1);
  });
  it("retries an op whose parent has not arrived instead of losing it", () => {
    let doc = reduceOps(emptyDoc(), [
      { seq: 1, op: { op: "append", parent: "root", child: { id: "c", type: "Text", text: "内容" } } },
    ]);
    expect(doc.retry).toHaveLength(1);
    expect(doc.nodes["c"]).toBeUndefined();

    doc = reduceOps(doc, [{ seq: 2, op: { op: "node", id: "root", type: "Col" } }]);
    expect(doc.retry).toEqual([]);
    expect(doc.nodes["c"]!.parent).toBe("root");
    expect(doc.nodes["root"]!.children).toEqual(["c"]);
  });
  it("shows Loading for a forward reference and fills it in without duplicating it", () => {
    const f = feeder();
    f.push({ op: "node", id: "root", type: "Col" });
    f.push({ op: "append", parent: "root", child: "s" });
    expect(f.doc.nodes["s"]!.type).toBe("Loading");
    expect(f.doc.nodes["s"]!.parent).toBe("root");
    expect(f.doc.nodes["root"]!.children).toEqual(["s"]);

    f.push({ op: "node", id: "s", type: "Stat", props: { label: "数量", value: "3" } });
    expect(f.doc.nodes["s"]!.type).toBe("Stat");
    expect(f.doc.nodes["s"]!.props).toMatchObject({ label: "数量", value: "3" });
    expect(f.doc.nodes["root"]!.children).toEqual(["s"]);
    expect(docNodeCount(f.doc)).toBe(2);
  });
  it("drops an illegal node id with an issue and does not throw", () => {
    const f = feeder();
    expect(() =>
      f.push(
        { op: "node", id: "has space", type: "Text" },
        { op: "node", id: "", type: "Text" },
        { op: "node", id: "a".repeat(300), type: "Text" },
      ),
    ).not.toThrow();
    expect(docNodeCount(f.doc)).toBe(0);
    expect(f.doc.issues.length).toBeGreaterThan(0);
  });
  it("refuses nesting deeper than the depth cap", () => {
    const ops: unknown[] = [{ op: "node", id: "n0", type: "Col" }];
    for (let i = 1; i <= UI_LIMITS.depth + 2; i++) ops.push({ op: "node", id: `n${i}`, type: "Col", parent: `n${i - 1}` });
    const doc = reduceOps(
      emptyDoc(),
      ops.map((op, i) => ({ seq: i + 1, op })),
    );
    expect(doc.nodes[`n${UI_LIMITS.depth - 1}`]).toBeDefined();
    expect(doc.nodes[`n${UI_LIMITS.depth}`]).toBeUndefined();
    expect(hasIssue(doc, "嵌套")).toBe(true);
  });
  it("refuses nodes past the node cap and keeps the count at the cap", () => {
    const ops = Array.from({ length: UI_LIMITS.nodes + 5 }, (_, i) => ({ op: "node", id: `n${i}`, type: "Text" }));
    const doc = reduceOps(
      emptyDoc(),
      ops.map((op, i) => ({ seq: i + 1, op })),
    );
    expect(docNodeCount(doc)).toBe(UI_LIMITS.nodes);
    expect(hasIssue(doc, String(UI_LIMITS.nodes))).toBe(true);
  });
  it("fails the block instead of growing forever past the op cap", () => {
    let doc = reduceOps(emptyDoc(), [{ seq: 1, op: { op: "node", id: "t", type: "Text" } }]);
    const texts = Array.from({ length: UI_LIMITS.ops }, () => ({ op: "text", id: "t", text: "x" }));
    doc = reduceOps(
      doc,
      texts.map((op, i) => ({ seq: i + 2, op })),
    );
    expect(doc.status).toBe("failed");
    expect(doc.error).toBeTruthy();
    expect(doc.ops).toBe(UI_LIMITS.ops + 1);
    expect(hasIssue(doc, String(UI_LIMITS.ops))).toBe(true);
  });
  it("caps long text and long row lists", () => {
    const f = feeder();
    f.push({ op: "node", id: "t", type: "Text" });
    f.push({ op: "text", id: "t", text: "x".repeat(UI_LIMITS.longText + 50) });
    expect((f.doc.nodes["t"]!.props.text as string).length).toBe(UI_LIMITS.longText);

    f.push({ op: "node", id: "c", type: "Card", props: { title: "t".repeat(UI_LIMITS.text + 20) } });
    expect((f.doc.nodes["c"]!.props.title as string).length).toBe(UI_LIMITS.text);

    const rows = Array.from({ length: UI_LIMITS.rows + 25 }, (_, i) => [i]);
    f.push({ op: "node", id: "tb", type: "Table", props: { columns: ["n"], rows } });
    expect((f.doc.nodes["tb"]!.props.rows as unknown[]).length).toBe(UI_LIMITS.rows);
    // Truncating is not silent: the block says so, so the reply can be shortened or paged.
    expect(hasIssue(f.doc, "只保留前")).toBe(true);
  });
  it("closes a block on done and stops on done with an error", () => {
    const ok = feeder().push({ op: "node", id: "a", type: "Col" }, { op: "done" });
    expect(ok.status).toBe("done");
    expect(ok.error).toBeNull();

    const f = feeder();
    f.push({ op: "node", id: "a", type: "Col" }, { op: "done", error: "  上游断了  " }, { op: "node", id: "b", type: "Col" });
    expect(f.doc.status).toBe("failed");
    expect(f.doc.error).toBe("上游断了");
    expect(f.doc.nodes["b"]).toBeUndefined(); // ops after a failure are ignored
  });
  it("treats done as the end of the block, not just of the happy path", () => {
    const f = feeder();
    f.push({ op: "node", id: "a", type: "Col" }, { op: "done" }, { op: "node", id: "b", type: "Col" });
    expect(f.doc.status).toBe("done");
    expect(f.doc.nodes["b"]).toBeUndefined();
  });
  it("reports one repeated mistake once, so the cap does not crowd out the real diagnostics", () => {
    const f = feeder();
    f.push({ op: "node", id: "a", type: "Stat", props: { value: 1 } });
    for (let i = 0; i < 30; i++) f.push({ op: "update", id: "a", props: { value: 1 } });
    const missing = f.doc.issues.filter((i) => i.includes("缺少 label"));
    expect(missing.length).toBeLessThanOrEqual(1);
  });
  it("drops non-object and unknown ops with an issue, never throwing", () => {
    const f = feeder();
    expect(() => f.push("hello", 42, null, [], { op: "frobnicate" }, { op: 7 })).not.toThrow();
    expect(docNodeCount(f.doc)).toBe(0);
    expect(hasIssue(f.doc, "不是对象")).toBe(true);
    expect(hasIssue(f.doc, "frobnicate")).toBe(true);
  });
  it("refuses an op that makes a node its own child", () => {
    const f = feeder();
    f.push({ op: "node", id: "a", type: "Col" });
    expect(() => f.push({ op: "append", parent: "a", child: "a" })).not.toThrow();
    expect(f.doc.nodes["a"]!.children).toEqual([]);
    expect(hasIssue(f.doc, "自己")).toBe(true);

    f.push({ op: "node", id: "b", type: "Col", children: ["b"] });
    expect(f.doc.nodes["b"]!.children).toEqual([]);
  });
  it("keeps the nodes it built while the block is still streaming", () => {
    const body = '{"op":"node","id":"root","type":"Col"}\n{"op":"node","id":"t","type":"Text","parent":"root","text":"第一行"}';
    const blocks = uiJsonBlocks("写好了：\n" + uiJsonBlock("表格", body, false));
    expect(blocks[0]!.closed).toBe(false);

    const { values } = scanJsonValues(blocks[0]!.source);
    const doc = reduceOps(
      emptyDoc(),
      values.map((op, i) => ({ seq: i + 1, op })),
    );
    expect(doc.status).toBe("streaming");
    expect(doc.error).toBeNull();
    expect(doc.nodes["t"]!.parent).toBe("root");
    expect(doc.nodes["t"]!.props.text).toBe("第一行");
  });
});

// ── D. actions and URLs ──────────────────────────────────

describe("normalizeAction", () => {
  it("takes the shorthands a model reaches for and the explicit shapes", () => {
    expect(normalizeAction("  去做  ")).toEqual({ type: "send", text: "去做" });
    expect(normalizeAction({ send: "发这个" })).toEqual({ type: "send", text: "发这个" });
    expect(normalizeAction({ copy: "复制我" })).toEqual({ type: "copy", text: "复制我" });
    expect(normalizeAction({ open: "https://example.com/a" })).toEqual({ type: "open", url: "https://example.com/a" });
    expect(normalizeAction({ type: "state", key: "rate", value: 3 })).toEqual({ type: "state", key: "rate", value: 3 });
    expect(normalizeAction({ type: "submit" })).toEqual({ type: "submit" });
    expect(normalizeAction({ type: "reset" })).toEqual({ type: "reset" });
    expect(normalizeAction({ type: "send", text: "x", confirm: true })).toEqual({ type: "send", text: "x", confirm: true });
  });
  it("returns null for anything that is not an action", () => {
    for (const junk of [null, undefined, 42, true, [], {}, "", "   ", { type: "launch" }, { type: "open" }, { nope: 1 }]) {
      expect(normalizeAction(junk)).toBeNull();
    }
  });
  it("caps the text an action may carry, the same way in every shape", () => {
    // All three shapes end up at UI_LIMITS.actionText, and an over-long one is truncated rather than
    // dropped: losing the message would be worse than shortening it.
    const long = "x".repeat(UI_LIMITS.actionText + 10);
    expect(normalizeAction(long)).toEqual({ type: "send", text: "x".repeat(UI_LIMITS.actionText) });
    expect(normalizeAction({ send: long })).toEqual({ type: "send", text: "x".repeat(UI_LIMITS.actionText) });
    expect(normalizeAction({ type: "send", text: long })).toEqual({ type: "send", text: "x".repeat(UI_LIMITS.actionText) });
    expect(normalizeAction({ type: "send", text: "短的" })).toEqual({ type: "send", text: "短的" });
  });
});

describe("safeUrl", () => {
  it("keeps plain http(s) links", () => {
    expect(safeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeUrl("http://example.com/")).toBe("http://example.com/");
  });
  it("rejects everything else", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "http://user:pw@example.com/",
      "ftp://example.com/x",
      "not a url",
      "/relative",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      expect(safeUrl(bad)).toBeNull();
    }
  });
});

// ── E. persistence and the hub side ──────────────────────

describe("migrateDoc", () => {
  it("round-trips a stored document", () => {
    const doc = feeder().push(
      { op: "node", id: "root", type: "Col" },
      { op: "node", id: "s", type: "Stat", parent: "root", props: { label: "总量", value: "3" } },
      { op: "append", parent: "root", child: { id: "txt", type: "Text", text: "一句话" } },
      { op: "done" },
    );
    const round = migrateDoc(JSON.parse(JSON.stringify(doc)));
    expect(round).toEqual(doc);
    expect(round!.status).toBe("done");
    expect(round!.nodes["s"]!.parent).toBe("root");
  });
  it("refuses null, garbage and a newer version", () => {
    for (const junk of [null, undefined, "nope", 42, [], true]) expect(migrateDoc(junk)).toBeNull();
    expect(migrateDoc({ v: UI_DOC_VERSION + 1, nodes: {} })).toBeNull();
    expect(migrateDoc({ v: UI_DOC_VERSION, seq: 2, roots: ["a"], nodes: { a: { type: "Col", parent: null, props: {}, children: [] } } })).not.toBeNull();
  });
});

describe("UiStreams", () => {
  const run = { id: "r1", agent_id: "a1", conversation_id: "cv1" };
  it("turns a streamed reply into gapless ui.op events and one stored document", () => {
    const { rows, db } = fakeDb();
    const { events, store } = fakeStore();
    const streams = new UiStreams(db, store);

    const ops = [
      { op: "node", id: "root", type: "Col" },
      ...Array.from({ length: 70 }, (_, i) => ({ op: "node", id: `n${i}`, type: "Text", parent: "root", text: `第 ${i} 行` })),
      { op: "done" },
    ];
    const reply = "算好了：\n" + uiJsonBlock("结果", ops.map((o) => JSON.stringify(o)).join("\n")) + "\n";

    // The reply arrives as deltas that cut lines in half, then once more as the finished text.
    for (let i = 0; i < reply.length; i += 40) streams.onText(run, "m1", reply.slice(i, i + 40), false);
    streams.onText(run, "m1", reply, true);

    const emitted = opEvents(events);
    expect(emitted.length).toBeGreaterThan(1); // one delta at a time reaches #apply, so one op per event
    let highest = 0;
    for (const ev of emitted) {
      expect(ev.runId).toBe("r1");
      expect(ev.messageId).toBe("m1");
      expect(ev.blockId).toBe("0");
      // Never skips an index: an event either continues from the last one or revises it (the reading
      // of an op the model is still writing). A gap would leave the browser waiting forever.
      expect(ev.from).toBeLessThanOrEqual(highest + 1);
      highest = Math.max(highest, ev.from + ev.ops.length - 1);
    }
    expect(highest).toBe(ops.length);
    // The first thing out is the reading of the op as far as it had got, marked as partial; the same
    // index later carries the finished op.
    expect(emitted[0]!.ops[0]).toMatchObject({ op: "node", partial: true });
    const settled = emitted.find((ev) => ev.from === 1 && !(ev.ops[0] as { partial?: boolean }).partial);
    expect(settled?.ops[0]).toMatchObject({ op: "node", id: "root", type: "Col" });

    const states = stateEvents(events);
    const last = states.at(-1)!;
    expect(last.messageId).toBe("m1");
    expect(last.blockId).toBe("0");
    expect(last.status).toBe("done");
    expect(last.ops).toBe(ops.length);
    expect(last.nodes).toBe(71);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toHaveLength(10);
    expect(row[1]).toBe("r1");
    expect(row[2]).toBe("m1");
    expect(row[3]).toBe("0");
    expect(row[4]).toBe("结果");
    expect(row[5]).toBe("done");
    const stored = JSON.parse(String(row[8])) as UIDoc;
    expect(stored.status).toBe("done");
    expect(stored.nodes["root"]!.children).toHaveLength(70);
  });
  it("splits a large batch into 64-op events", () => {
    const { db } = fakeDb();
    const { events, store } = fakeStore();
    const streams = new UiStreams(db, store);
    const ops = Array.from({ length: 70 }, (_, i) => ({ op: "node", id: `n${i}`, type: "Text" }));
    const reply = uiJsonBlock("列表", ops.map((o) => JSON.stringify(o)).join("\n"));
    streams.onText(run, "m3", reply, false);
    streams.onText(run, "m3", reply, true);
    expect(opEvents(events).map((e) => [e.from, e.ops.length])).toEqual([
      [1, 64],
      [65, 6],
    ]);
  });
  it("closes an open block on finishRun and reads it back with loadUiBlocks", () => {
    const db = openDb(":memory:");
    const { events, store } = fakeStore();
    const streams = new UiStreams(db, store);

    const body = [
      JSON.stringify({ op: "node", id: "root", type: "Col" }),
      JSON.stringify({ op: "append", parent: "root", child: { id: "s", type: "Stat", props: { label: "数量", value: "3" } } }),
    ].join("\n");
    streams.onText(run, "m2", uiJsonBlock("表", body, false), false);
    expect(loadUiBlocks(db, "m2")).toEqual([]); // still open: nothing stored yet

    streams.finishRun("r1");
    const blocks = loadUiBlocks(db, "m2");
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.blockId).toBe("0");
    expect(block.title).toBe("表");
    expect(block.status).toBe("done");
    expect(block.doc.nodes["s"]!.parent).toBe("root");
    expect(block.doc.nodes["s"]!.props).toMatchObject({ label: "数量", value: "3" });
    expect(stateEvents(events).at(-1)!.status).toBe("done");
    db.close();
  });
});
