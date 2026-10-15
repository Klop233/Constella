import { GENUI_SCHEMA } from "../genui.ts";
import { UI_LIMITS, capRows, pushIssue, validateProps } from "./schema.ts";

// The normalized state tree behind a streaming UI block, and the reducer that builds it from ops.
// Shared by the hub (which validates the model's lines and forwards them) and the browser (which
// rebuilds the same tree from the events, or straight from the reply text when an event was missed),
// so both sides always agree on what a block means.
//
// The model writes ops; this file decides what they do. It never throws and never gives up on a whole
// block: an op that can't be applied yet waits for the one it needs, an op that makes no sense is
// dropped with a diagnostic, and a component that was never created is shown as Loading until it is.

/** Bumped when the shape of UIDoc changes; older snapshots are converted by migrateDoc. */
export const UI_DOC_VERSION = 1;

/** A child of a node: another node's id, or literal text rendered inline. */
export type UIChild = string | { text: string };

export interface UINode {
  id: string;
  type: string;
  parent: string | null;
  props: Record<string, unknown>;
  children: UIChild[];
}

export type UIStatus = "streaming" | "done" | "failed";

export interface UIDoc {
  v: number;
  /** Highest op index applied; ops arrive numbered from 1. */
  seq: number;
  /** True when the op at `seq` is a partial reading of one the model is still writing. */
  partial: boolean;
  roots: UIChild[];
  nodes: Record<string, UINode>;
  /** Ops that arrived early (a gap in the stream); keyed by their index. */
  pending: Record<string, unknown>;
  /** Ops whose parent or target hasn't been created yet. */
  retry: unknown[];
  issues: string[];
  status: UIStatus;
  error: string | null;
  /** How many ops have been applied, for the caps and the progress line. */
  ops: number;
}

export interface UIOpEntry {
  seq: number;
  op: unknown;
}

export function emptyDoc(): UIDoc {
  return { v: UI_DOC_VERSION, seq: 0, partial: false, roots: [], nodes: {}, pending: {}, retry: [], issues: [], status: "streaming", error: null, ops: 0 };
}

export function docNodeCount(doc: UIDoc): number {
  return Object.keys(doc.nodes).length;
}

/**
 * True for a value that is an op: an object naming one. The hub applies the same rule before it
 * forwards an op and the browser applies it while re-reading a reply, so both number the ops in a
 * block identically — a mismatch would leave the browser waiting for a gap that never fills.
 */
export function isUiOp(value: unknown): value is { op: string } & Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = (value as { op?: unknown }).op;
  return typeof op === "string" && op.length > 0 && op.length <= 16;
}

/** True for an op the hub marked as the best reading of something still being written. */
export function isPartialOp(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { partial?: unknown }).partial === true;
}

const REVISABLE_OPS = new Set(["node", "create", "update", "set", "data", "text"]);

/**
 * Op kinds a half-written reading can be trusted with. A `node` op replaces its subtree wholesale, so
 * applying a partial reading and revising it later is exact; an `append` would leave a second,
 * auto-numbered child behind, so it waits until it is complete.
 */
export function isRevisableOp(value: unknown): boolean {
  return isUiOp(value) && REVISABLE_OPS.has(value.op.toLowerCase());
}

// ── reading JSON out of a stream ─────────────────────────

/**
 * The index just past the JSON value starting at `start`, or -1 when it isn't complete yet.
 * Used while the reply streams, so it must not need a newline: a value is taken as soon as its
 * brackets and quotes balance.
 */
function endOfValue(text: string, start: number): number {
  const first = text[start]!;
  if (first === "{" || first === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  if (first === '"') {
    let escaped = false;
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') return i + 1;
    }
    return -1;
  }
  let i = start;
  while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
  return i > start ? i : -1;
}

/**
 * The most complete reading of a JSON value that is still being written, or null. Walks back to the
 * last point where a value ended and closes whatever is still open, so a model that writes one big
 * tree in a single op still shows that tree growing instead of appearing all at once.
 */
function salvage(text: string, start: number): string | null {
  const closers: string[] = [];
  /** A place where a value ended, with the closers that were open there (they differ per place). */
  const safe: { at: number; tail: string }[] = [];
  const mark = (at: number) => safe.push({ at, tail: [...closers].reverse().join("") });
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        mark(i + 1);
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") closers.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      closers.pop();
      mark(i + 1);
    } else if (/[0-9tfn-]/.test(ch)) {
      let j = i;
      while (j < text.length && !/[\s,\]}]/.test(text[j]!)) j++;
      if (j >= text.length) break; // the token may still be growing
      mark(j);
      i = j - 1;
    }
  }
  if (!closers.length) return null;
  // Try the last few places a value ended, longest first: the most recent one is usually the best.
  for (let k = safe.length - 1; k >= 0 && k >= safe.length - 8; k--) {
    const spot = safe[k]!;
    const repaired = text.slice(start, spot.at) + spot.tail;
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      // that cut is mid-key or mid-token; try one earlier
    }
  }
  return null;
}

/**
 * Every complete JSON value in `text` from `next` on, plus where to continue. One value per line is
 * the documented form, but a pretty-printed object, a `[...]` array of ops and values written back
 * to back all work — which is what keeps a half-written reply readable instead of broken.
 *
 * `open` says the last value returned is a partial reading of a value that is still being written
 * (and `next` still points at its start, so the next chunk revises it).
 */
export function scanJsonValues(text: string, next = 0): { values: unknown[]; next: number; bad: number; open: boolean } {
  const values: unknown[] = [];
  let i = Math.max(0, Math.min(next, text.length));
  let bad = 0;
  let open = false;
  while (i < text.length) {
    while (i < text.length && /[\s,;]/.test(text[i]!)) i++;
    if (i >= text.length) break;
    if (text[i] === "}" || text[i] === "]") {
      // A stray closer (a truncated or duplicated op). Skip it and keep reading: parking here would
      // lose every later op in the block with nothing to show for it.
      i++;
      bad++;
      continue;
    }
    const end = endOfValue(text, i);
    if (end < 0) {
      const repaired = salvage(text, i);
      if (repaired !== null) {
        try {
          const parsed: unknown = JSON.parse(repaired);
          if (Array.isArray(parsed)) values.push(...parsed.slice(0, UI_LIMITS.items));
          else values.push(parsed);
          open = true;
        } catch {
          // not readable yet
        }
      }
      break;
    }
    const slice = text.slice(i, end);
    i = end;
    if (slice.length > UI_LIMITS.op) {
      bad++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      bad++;
      continue;
    }
    if (Array.isArray(parsed)) values.push(...parsed.slice(0, UI_LIMITS.items));
    else values.push(parsed);
  }
  return { values, next: i, bad, open };
}

// ── applying ops ─────────────────────────────────────────

type Apply = "ok" | "retry" | "drop";

function note(d: UIDoc, message: string): void {
  pushIssue(d.issues, message);
}

function asId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return UI_LIMITS.id.test(s) ? s : null;
}

function capText(v: string): string {
  return v.length > UI_LIMITS.longText ? v.slice(0, UI_LIMITS.longText) : v;
}

function depthOf(d: UIDoc, id: string): number {
  let depth = 0;
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && depth <= UI_LIMITS.depth + 1) {
    if (seen.has(cur)) return UI_LIMITS.depth + 2;
    seen.add(cur);
    cur = d.nodes[cur]?.parent ?? null;
    depth++;
  }
  return depth;
}

function autoId(d: UIDoc, parent: string | null): string {
  const base = (parent ?? "root").slice(0, 48);
  for (let i = 0; i < UI_LIMITS.nodes + 8; i++) {
    const id = `${base}.${i}`;
    if (!d.nodes[id]) return id;
  }
  return `${base}.${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The child list of a node, cloned on access. Every mutation goes through here, so a node that did
 * not change keeps its object identity — which is what lets the browser memoize whole subtrees.
 */
function listFor(d: UIDoc, parent: string | null): UIChild[] | null {
  if (parent === null) return d.roots;
  const node = d.nodes[parent];
  if (!node) return null;
  const clone: UINode = { ...node, children: [...node.children] };
  d.nodes[parent] = clone;
  return clone.children;
}

/** True when `node` is `ancestor` or sits under it (moving it there would make a cycle). */
function isUnder(d: UIDoc, node: string | null, ancestor: string): boolean {
  let cur = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = d.nodes[cur]?.parent ?? null;
  }
  return false;
}

function pushChild(d: UIDoc, parent: string | null, child: UIChild): void {
  const list = listFor(d, parent);
  if (!list) return;
  // The depth cap has to hold for every way a node is attached, not just for `node` ops.
  if (parent !== null && depthOf(d, parent) + 1 > UI_LIMITS.depth) {
    note(d, `嵌套超过 ${UI_LIMITS.depth} 层，已忽略`);
    return;
  }
  if (list.some((c) => c === child || (typeof c === "object" && typeof child === "object" && c.text === child.text))) return;
  if (list.length >= UI_LIMITS.children) {
    note(d, `一个组件最多 ${UI_LIMITS.children} 个子组件，多余的已忽略`);
    return;
  }
  list.push(child);
}

/** References to a node that doesn't exist yet become a Loading placeholder, filled in when it arrives. */
function placeholder(d: UIDoc, id: string, parent: string | null): UINode | null {
  if (Object.keys(d.nodes).length >= UI_LIMITS.nodes) {
    note(d, `组件数量超过 ${UI_LIMITS.nodes}，后面的已忽略`);
    return null;
  }
  const node: UINode = { id, type: "Loading", parent, props: {}, children: [] };
  d.nodes[id] = node;
  return node;
}

function addChild(d: UIDoc, parent: string | null, entry: unknown, revising = false): void {
  if (typeof entry === "string") {
    const id = asId(entry);
    if (!id) {
      note(d, "引用了不合法的组件 id");
      return;
    }
    if (id === parent || (parent !== null && isUnder(d, parent, id))) {
      note(d, "组件不能放进自己的子组件里");
      return;
    }
    if (!d.nodes[id]) {
      if (!placeholder(d, id, parent)) return;
    } else if (d.nodes[id]!.parent !== parent) detach(d, id);
    d.nodes[id] = { ...d.nodes[id]!, parent };
    pushChild(d, parent, id);
    return;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const inline = entry as Record<string, unknown>;
    const id = asId(inline.id) ?? autoId(d, parent);
    if (createNode(d, { ...inline, id, op: "node", parent }, revising) !== "ok") {
      note(d, "内联的子组件没有建立");
      return;
    }
    // createNode links a node it creates; one that already existed (the same id written again, a
    // forward reference, or the previous reading of a revision) has to be linked here instead.
    const node = d.nodes[id];
    if (node && node.parent !== parent) d.nodes[id] = { ...node, parent };
    pushChild(d, parent, id);
    return;
  }
  note(d, "子组件只能是 id 或组件对象");
}

const STRUCTURAL = new Set(["op", "id", "type", "parent", "index", "at", "children", "props", "replace", "seq", "after", "text"]);

/** Props may be given under `props` or spread next to the node's own fields (both are common). */
function collectProps(type: string, o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.props && typeof o.props === "object" && !Array.isArray(o.props)) Object.assign(out, o.props as Record<string, unknown>);
  const spec = GENUI_SCHEMA[type];
  if (spec) {
    const known = new Set<string>();
    for (const [k, ps] of Object.entries(spec.props)) {
      known.add(k);
      for (const a of ps.alias ?? []) known.add(a);
    }
    for (const [k, v] of Object.entries(o)) if (known.has(k) && !STRUCTURAL.has(k) && !(k in out)) out[k] = v;
  }
  if (typeof o.text === "string" && out.text === undefined) out.text = capText(o.text);
  return out;
}

function createNode(d: UIDoc, o: Record<string, unknown>, revising = false): Apply {
  const id = asId(o.id);
  const type = typeof o.type === "string" ? o.type.trim().slice(0, 40) : "";
  if (!id) {
    note(d, "跳过了一个 id 不合法的组件");
    return "drop";
  }
  if (!type) {
    note(d, `${id} 没有 type`);
    return "drop";
  }
  const parent = o.parent === null || o.parent === undefined || o.parent === "" ? null : asId(o.parent);
  if (parent !== null && !d.nodes[parent]) return "retry"; // its parent op hasn't arrived yet
  const existing = d.nodes[id];
  const nested = Array.isArray(o.children) ? o.children : Array.isArray((o.props as Record<string, unknown> | undefined)?.children) ? ((o.props as Record<string, unknown>).children as unknown[]) : [];
  if (existing) {
    if (!revising) {
      // The same id again (a replayed stream, or a placeholder being filled in): merge instead of failing.
      return updateNode(d, { op: "update", id, type, props: collectProps(type, o) });
    }
    // A revision is the best reading of an op the model is still writing: replace the node wholesale,
    // so a child that the finished version drops doesn't linger from an earlier reading. The parent
    // comes from this reading too — a half-written op has no parent yet, and the node must move.
    const props = validateProps(type, collectProps(type, o), id, d.issues) ?? {};
    capRows(type, props, d.issues);
    detach(d, id);
    d.nodes[id] = { id, type, parent, props, children: [] };
    pushChild(d, parent, id);
    // Clear the old subtree first, so children without an id get the same auto ids every time —
    // stable ids are what lets the browser keep a node instead of rebuilding it on every revision.
    prune(d);
    for (const entry of nested.slice(0, UI_LIMITS.children)) addChild(d, id, entry, true);
    return "ok";
  }
  if (Object.keys(d.nodes).length >= UI_LIMITS.nodes) {
    note(d, `组件数量超过 ${UI_LIMITS.nodes}，后面的已忽略`);
    return "drop";
  }
  if (parent !== null && depthOf(d, parent) + 1 > UI_LIMITS.depth) {
    note(d, `嵌套超过 ${UI_LIMITS.depth} 层，已忽略 ${id}`);
    return "drop";
  }
  const props = validateProps(type, collectProps(type, o), id, d.issues) ?? {};
  capRows(type, props, d.issues);
  const node: UINode = { id, type, parent, props, children: [] };
  d.nodes[id] = node;
  pushChild(d, parent, id);
  for (const entry of nested.slice(0, UI_LIMITS.children)) addChild(d, id, entry, revising);
  return "ok";
}

function updateNode(d: UIDoc, o: Record<string, unknown>): Apply {
  const id = asId(o.id);
  if (!id) {
    note(d, "update 缺少 id");
    return "drop";
  }
  const node = d.nodes[id];
  if (!node) return "retry"; // wait for its create op
  const type = typeof o.type === "string" && o.type.trim() ? o.type.trim().slice(0, 40) : node.type;
  const incoming = collectProps(type, o);
  const props = validateProps(type, incoming, id, d.issues);
  // `updateData`/`update` merge: a stream that fills a table row by row must not wipe earlier rows.
  const merged = o.replace === true ? (props ?? {}) : { ...node.props, ...(props ?? {}) };
  capRows(type, merged, d.issues);
  d.nodes[id] = { ...node, type, props: merged };
  return "ok";
}

function setText(d: UIDoc, o: Record<string, unknown>): Apply {
  const id = asId(o.id);
  if (!id) {
    note(d, "text 缺少 id");
    return "drop";
  }
  const node = d.nodes[id];
  if (!node) return "retry";
  if (typeof o.text !== "string") {
    note(d, `text 需要一个字符串`);
    return "drop";
  }
  d.nodes[id] = { ...node, props: { ...node.props, text: capText(o.text) } };
  return "ok";
}

function detach(d: UIDoc, id: string): void {
  const parent = d.nodes[id]?.parent ?? null;
  const list = listFor(d, parent);
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) if (list[i] === id) list.splice(i, 1);
}

/** Deletes a node and everything under it. */
function dropSubtree(d: UIDoc, id: string): void {
  // Unlink first, while the node still knows where it was: after the deletion there is nothing left
  // to tell its old parent to let go, and the parent would keep a dead id in its children forever.
  detach(d, id);
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = d.nodes[cur];
    if (!node) continue;
    for (const c of node.children) if (typeof c === "string") stack.push(c);
    delete d.nodes[cur];
  }
}

function removeNode(d: UIDoc, o: Record<string, unknown>): Apply {
  const id = asId(o.id);
  if (!id) {
    note(d, "remove 缺少 id");
    return "drop";
  }
  if (!d.nodes[id]) return "drop"; // already gone: nothing to do
  dropSubtree(d, id);
  return "ok";
}

function insertChild(d: UIDoc, o: Record<string, unknown>, index: number): Apply {
  const rawParent = o.parent;
  const parent = rawParent === null || rawParent === undefined || rawParent === "" ? null : asId(rawParent);
  if (parent !== null && !d.nodes[parent]) return "retry";
  const entry = o.child ?? o.node;
  if (entry === undefined) {
    note(d, `${o.op === "insert" ? "insert" : "append"} 缺少 child`);
    return "drop";
  }
  // A child given by id that doesn't exist yet is created as a Loading placeholder, so a forward
  // reference shows a skeleton instead of nothing.
  if (typeof entry === "string") {
    const id = asId(entry);
    if (!id) {
      note(d, "引用了不合法的组件 id");
      return "drop";
    }
    if (id === parent || (parent !== null && isUnder(d, parent, id))) {
      note(d, "组件不能放进自己的子组件里");
      return "drop";
    }
    if (!d.nodes[id] && !placeholder(d, id, parent)) return "drop";
  }
  const list = listFor(d, parent);
  if (!list) return "drop";
  const at = index < 0 || index > list.length ? list.length : index;
  if (typeof entry === "string") {
    const id = entry;
    // Moving a node: let go of where it was first, or it would stay reachable from two places.
    if (d.nodes[id]!.parent !== parent) detach(d, id);
    const target = listFor(d, parent);
    if (!target) return "drop";
    const from = target.indexOf(id);
    if (from >= 0) target.splice(from, 1);
    if (parent !== null && depthOf(d, parent) + 1 > UI_LIMITS.depth) {
      note(d, `嵌套超过 ${UI_LIMITS.depth} 层，已忽略`);
      return "drop";
    }
    if (target.length >= UI_LIMITS.children) {
      note(d, `一个组件最多 ${UI_LIMITS.children} 个子组件`);
      return "drop";
    }
    d.nodes[id] = { ...d.nodes[id]!, parent };
    target.splice(Math.min(at, target.length), 0, id);
    return "ok";
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const inline = entry as Record<string, unknown>;
    const id = asId(inline.id) ?? autoId(d, parent);
    if (createNode(d, { ...inline, id, op: "node", parent }) !== "ok") {
      note(d, "内联的子组件没有建立");
      return "drop";
    }
    const cur = listFor(d, parent)!;
    const from = cur.indexOf(id);
    if (from >= 0 && from !== at) {
      cur.splice(from, 1);
      cur.splice(Math.min(at, cur.length), 0, id);
    }
    return "ok";
  }
  note(d, "child 只能是 id 或组件对象");
  return "drop";
}

/** Only nodes reachable from the roots stay; used after replaceChildren and removes. */
function prune(d: UIDoc): void {
  const reachable = new Set<string>();
  const stack = [...d.roots];
  while (stack.length) {
    const entry = stack.pop()!;
    if (typeof entry !== "string") continue;
    if (reachable.has(entry)) continue;
    reachable.add(entry);
    const node = d.nodes[entry];
    if (node) for (const c of node.children) stack.push(c);
  }
  for (const id of Object.keys(d.nodes)) if (!reachable.has(id)) delete d.nodes[id];
}

function replaceChildren(d: UIDoc, o: Record<string, unknown>): Apply {
  const rawParent = o.parent;
  const parent = rawParent === null || rawParent === undefined || rawParent === "" ? null : asId(rawParent);
  if (parent !== null && !d.nodes[parent]) return "retry";
  const list = listFor(d, parent);
  if (!list) return "drop";
  list.length = 0;
  const entries = Array.isArray(o.children) ? o.children : Array.isArray(o.child) ? [o.child] : [];
  for (const entry of entries.slice(0, UI_LIMITS.children)) addChild(d, parent, entry);
  prune(d);
  return "ok";
}

function finish(d: UIDoc, o: Record<string, unknown>): Apply {
  const error = typeof o.error === "string" && o.error.trim() ? o.error.trim().slice(0, 300) : null;
  d.status = error ? "failed" : "done";
  d.error = error;
  return "ok";
}

function applyOp(d: UIDoc, raw: unknown, revising = false): Apply {
  // A block that said `done` (or failed) is closed: anything after it is not part of this interface.
  if (d.status !== "streaming") return "drop";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    note(d, "忽略了一条不是对象的指令");
    return "drop";
  }
  const o = raw as Record<string, unknown>;
  const kind = typeof o.op === "string" ? o.op.toLowerCase() : "";
  const index = typeof o.index === "number" ? o.index : typeof o.at === "number" ? o.at : -1;
  switch (kind) {
    case "node":
    case "create":
      return createNode(d, o, revising);
    case "update":
    case "set":
    case "data":
      return updateNode(d, o);
    case "text":
      return setText(d, o);
    case "remove":
    case "delete":
      return removeNode(d, o);
    case "append":
      return insertChild(d, o, -1);
    case "insert":
      return insertChild(d, o, index);
    case "replace":
      return replaceChildren(d, o);
    case "done":
    case "complete":
      return finish(d, o);
    default:
      note(d, `不认识的指令 ${kind || "(空)"}`);
      return "drop";
  }
}

/**
 * Applies one op. A half-written op is expected to be missing things, so its complaints are collected
 * and dropped rather than shown as the block's problems.
 */
function applyEntry(d: UIDoc, op: unknown, revising: boolean): Apply {
  const partial = isPartialOp(op);
  d.partial = partial;
  const kept = d.issues;
  if (partial) d.issues = [];
  const result = applyOp(d, op, revising);
  if (partial) d.issues = kept;
  return result;
}

function drain(d: UIDoc): void {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (;;) {
      const next = d.pending[String(d.seq + 1)];
      if (next === undefined) break;
      delete d.pending[String(d.seq + 1)];
      d.seq += 1;
      d.ops += 1;
      if (d.ops > UI_LIMITS.ops) {
        note(d, `这个界面的指令超过 ${UI_LIMITS.ops} 条，后面的已忽略`);
        d.status = "failed";
        d.error = "指令数量超出上限";
        return;
      }
      if (applyEntry(d, next, false) === "retry") d.retry.push(next);
      moved = true;
      // An op that couldn't be applied yet is older than everything that follows it, so it is retried
      // right here: retrying at the end would let it overwrite a later op with an earlier value.
      if (d.retry.length) retryPending(d);
    }
    if (!d.retry.length) break;
    if (!retryPending(d) && !moved) break;
  }
}

/** Re-applies ops that were waiting for something; returns true when at least one landed. */
function retryPending(d: UIDoc): boolean {
  const left: unknown[] = [];
  let applied = false;
  for (const op of d.retry) {
    if (applyEntry(d, op, false) === "retry") left.push(op);
    else applied = true;
  }
  d.retry = left.slice(0, 64);
  return applied;
}

/**
 * Applies ops to a doc and returns the new doc. Ops are numbered from 1: an op whose number was
 * already applied is ignored (a replayed stream), one that arrives early waits for the gap to be
 * filled, and one that refers to something not created yet waits for that instead of being lost.
 *
 * An op that says it is a `partial` reading, or that lands on the index of one, revises that op in
 * place — that is how a tree the model is still typing grows instead of popping in at the end.
 */
export function reduceOps(doc: UIDoc, entries: UIOpEntry[]): UIDoc {
  const fresh = entries.filter((entry) => Number.isFinite(entry.seq) && entry.seq > doc.seq);
  const revisions = entries.filter((entry) => Number.isFinite(entry.seq) && entry.seq === doc.seq && doc.seq > 0 && (doc.partial || isPartialOp(entry.op)) && isRevisableOp(entry.op));
  // Nothing new to apply: hand back the same object, so a browser that replays a block's ops on
  // every render keeps the node identities (and its memoized subtrees) intact.
  if (!fresh.length && !revisions.length) return doc;
  const d: UIDoc = {
    ...doc,
    roots: [...doc.roots],
    nodes: { ...doc.nodes },
    pending: { ...doc.pending },
    retry: [...doc.retry],
    issues: [...doc.issues],
  };
  for (const revision of revisions) {
    if (applyEntry(d, revision.op, true) === "retry") note(d, "这一条指令还没法应用");
  }
  for (const entry of fresh) {
    d.pending[String(entry.seq)] = entry.op;
  }
  const keys = Object.keys(d.pending)
    .map(Number)
    .sort((a, b) => a - b);
  if (keys.length > UI_LIMITS.pending) {
    for (const k of keys.slice(UI_LIMITS.pending)) delete d.pending[String(k)];
    note(d, "等待补齐的指令太多，已丢弃一部分");
  }
  drain(d);
  return d;
}

// ── persistence ──────────────────────────────────────────

function normalizeChildren(v: unknown): UIChild[] {
  if (!Array.isArray(v)) return [];
  const out: UIChild[] = [];
  for (const entry of v.slice(0, UI_LIMITS.children)) {
    if (typeof entry === "string") {
      const id = asId(entry);
      if (id) out.push(id);
    } else if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
      out.push({ text: (entry as { text: string }).text.slice(0, UI_LIMITS.longText) });
    }
  }
  return out;
}

/**
 * Reads a stored snapshot back. Unknown versions are refused rather than guessed at; older ones go
 * through the conversions below, which is the single place a DSL shape change has to be handled.
 */
export function migrateDoc(raw: unknown): UIDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const version = typeof o.v === "number" && Number.isFinite(o.v) ? o.v : 0;
  if (version > UI_DOC_VERSION) return null;
  const doc = emptyDoc();
  doc.seq = typeof o.seq === "number" && Number.isFinite(o.seq) ? o.seq : 0;
  doc.partial = o.partial === true;
  doc.ops = typeof o.ops === "number" && Number.isFinite(o.ops) ? o.ops : doc.seq;
  doc.status = o.status === "done" || o.status === "failed" ? o.status : "streaming";
  doc.error = typeof o.error === "string" ? o.error.slice(0, 300) : null;
  doc.issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === "string").slice(0, UI_LIMITS.diagnostics) : [];
  doc.roots = normalizeChildren(o.roots);
  if (o.nodes && typeof o.nodes === "object" && !Array.isArray(o.nodes)) {
    for (const [id, value] of Object.entries(o.nodes as Record<string, unknown>).slice(0, UI_LIMITS.nodes)) {
      if (!UI_LIMITS.id.test(id) || !value || typeof value !== "object") continue;
      const node = value as Record<string, unknown>;
      doc.nodes[id] = {
        id,
        type: typeof node.type === "string" && node.type ? node.type.slice(0, 40) : "Loading",
        parent: typeof node.parent === "string" && UI_LIMITS.id.test(node.parent) ? node.parent : null,
        props: node.props && typeof node.props === "object" && !Array.isArray(node.props) ? (node.props as Record<string, unknown>) : {},
        children: normalizeChildren(node.children),
      };
    }
  }
  return doc;
}
