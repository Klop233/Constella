import {
  UI_LIMITS,
  UI_OPS_PER_EVENT,
  docNodeCount,
  emptyDoc,
  isUiOp,
  migrateDoc,
  reduceOps,
  scanJsonValues,
  uiJsonBlocks,
  type RunnerEvent,
  type UIDoc,
  type UIStatus,
} from "@constella/protocol";
import { nowIso } from "./config.ts";
import type { Db } from "./db.ts";
import type { EventStore } from "./events.ts";

// The hub side of the streaming UI DSL (```ui-json blocks). While an agent reply is being written the
// hub reads the block out of the text, checks each op (JSON well-formedness, op name, caps) and
// forwards it as `ui.op` events; the browser rebuilds the same tree with the same reducer
// (packages/protocol/src/streamui/doc.ts). Nothing the model writes is executed: components, props
// and actions are whitelisted there, so a hostile reply can at worst draw a wrong card.
//
// The finished document is stored per block, which is what restores a conversation whose events have
// been pruned and what lets an older DSL version be converted instead of guessed at.

/** An op is forwarded only when it is an object naming a known op; anything else is counted and dropped. */
function isOp(value: unknown): value is { op: string } & Record<string, unknown> {
  return isUiOp(value);
}

interface BlockState {
  index: number;
  title: string;
  doc: UIDoc;
  /** How much of the block's text has been scanned. */
  cursor: number;
  /** Op index of the last op emitted. */
  seq: number;
  /** True when the op at `seq` is a partial reading of one the model is still writing. */
  provisional: boolean;
  /** The last partial reading emitted, so an unchanged one isn't sent again on every delta. */
  lastPartial: string;
  dropped: number;
  failed: string | null;
  finalized: boolean;
}

export interface StoredUiBlock {
  blockId: string;
  title: string;
  status: UIStatus;
  doc: UIDoc;
}

/** One reply being written: the text so far, and the blocks found in it. */
class MessageStream {
  readonly runId: string;
  readonly messageId: string;
  #emit: (ev: RunnerEvent) => void;
  #text = "";
  #blocks = new Map<number, BlockState>();
  #lastState = 0;

  constructor(runId: string, messageId: string, emit: (ev: RunnerEvent) => void) {
    this.runId = runId;
    this.messageId = messageId;
    this.#emit = emit;
  }

  /** A delta, or the finished text. The finished text may differ from what was streamed. */
  feed(text: string, final: boolean): void {
    if (final) {
      if (text.startsWith(this.#text)) {
        this.#push(text.slice(this.#text.length));
      } else {
        // The engine's finished text differs from what it streamed (whitespace, a rewritten tail).
        // What we already built stands — the browser has those ops — so only a block that produced
        // nothing gets re-read, rather than replaying every op under a second set of indices.
        for (const st of this.#blocks.values()) if (!st.seq) st.cursor = 0;
        this.#push("");
      }
      this.finish();
      return;
    }
    this.#push(text);
  }

  #push(chunk: string): void {
    if (chunk) this.#text += chunk;
    if (!this.#text.includes("`") && !this.#text.includes("~")) return;
    if (this.#text.length > UI_LIMITS.source) {
      this.#fail(`界面代码超过 ${UI_LIMITS.source} 字符`);
      return;
    }
    for (const block of uiJsonBlocks(this.#text)) {
      let st = this.#blocks.get(block.index);
      if (!st) {
        st = { index: block.index, title: block.title, doc: emptyDoc(), cursor: 0, seq: 0, provisional: false, lastPartial: "", dropped: 0, failed: null, finalized: false };
        this.#blocks.set(block.index, st);
      }
      if (block.title) st.title = block.title;
      if (block.source.length < st.cursor) st.cursor = 0;
      const scan = scanJsonValues(block.source, st.cursor);
      st.cursor = scan.next;
      st.dropped += scan.bad;
      if (scan.values.length) this.#apply(st, scan);
    }
    this.#emitStates(false);
  }

  #apply(st: BlockState, scan: { values: unknown[]; open: boolean }): void {
    const entries: { seq: number; op: unknown }[] = [];
    for (let i = 0; i < scan.values.length; i++) {
      const value = scan.values[i];
      if (!isOp(value)) {
        st.dropped++;
        continue;
      }
      // The last value of an unfinished read is the model's op as far as it has got: it revises the
      // op already at the cursor (or opens a new one), so a big tree shows up as it is typed.
      const partial = scan.open && i === scan.values.length - 1;
      if (partial) {
        // Only send a reading that says more than the last one: otherwise every delta would carry the
        // whole op again.
        const json = JSON.stringify(value);
        if (st.provisional && json === st.lastPartial) continue;
        st.lastPartial = json;
        if (!st.provisional) {
          if (st.seq >= UI_LIMITS.ops) {
            st.failed = `指令超过 ${UI_LIMITS.ops} 条`;
            break;
          }
          st.seq++;
          st.provisional = true;
        }
        entries.push({ seq: st.seq, op: { ...value, partial: true } });
        continue;
      }
      if (st.provisional) {
        // The op we were reading has finished: same index, no longer a partial reading.
        st.provisional = false;
        st.lastPartial = "";
        entries.push({ seq: st.seq, op: value });
        continue;
      }
      if (st.seq >= UI_LIMITS.ops) {
        st.failed = `指令超过 ${UI_LIMITS.ops} 条`;
        break;
      }
      st.seq++;
      entries.push({ seq: st.seq, op: value });
    }
    if (!entries.length) return;
    st.doc = reduceOps(st.doc, entries);
    if (st.doc.status === "failed" && !st.failed) st.failed = st.doc.error ?? "界面生成失败";
    // Only ops that were applied are sent, so the browser's op numbering has no gaps.
    for (let i = 0; i < entries.length; i += UI_OPS_PER_EVENT) {
      const batch = entries.slice(i, i + UI_OPS_PER_EVENT);
      this.#emit({
        type: "ui.op",
        runId: this.runId,
        messageId: this.messageId,
        blockId: String(st.index),
        from: batch[0]!.seq,
        ops: batch.map((e) => e.op as { op: string } & Record<string, unknown>),
      });
    }
  }

  /** One `ui.state` per pass, so a long block doesn't produce an event per op. */
  #emitStates(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.#lastState < 400) return;
    this.#lastState = now;
    for (const st of this.#blocks.values()) {
      if (st.finalized) continue;
      this.#emitState(st, st.failed ? "failed" : "streaming");
    }
  }

  #emitState(st: BlockState, status: UIStatus): void {
    this.#emit({
      type: "ui.state",
      runId: this.runId,
      messageId: this.messageId,
      blockId: String(st.index),
      status,
      nodes: docNodeCount(st.doc),
      ops: st.seq,
      issues: st.doc.issues.slice(0, UI_LIMITS.diagnostics),
    });
  }

  #fail(message: string): void {
    for (const st of this.#blocks.values()) if (!st.failed) st.failed = message;
  }

  /** The reply is over (finished or cut off): close every block and store its document. */
  finish(): void {
    for (const st of this.#blocks.values()) {
      if (st.finalized) continue;
      st.finalized = true;
      const status: UIStatus = st.failed ? "failed" : "done";
      if (st.doc.status === "streaming") st.doc = { ...st.doc, status, error: st.failed };
      this.#emitState(st, status);
    }
  }

  blocks(): { runId: string; messageId: string; state: BlockState }[] {
    return [...this.#blocks.values()].map((state) => ({ runId: this.runId, messageId: this.messageId, state }));
  }
}

/** Every reply currently being written, keyed by run and message. */
export class UiStreams {
  #db: Db;
  #events: EventStore;
  #open = new Map<string, MessageStream>();

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  /** Text from the engine: a delta while it streams, the whole text when the message is complete. */
  onText(run: { id: string; agent_id: string; conversation_id: string }, messageId: string, text: string, final: boolean): void {
    const key = `${run.id}:${messageId}`;
    let stream = this.#open.get(key);
    if (!stream) {
      if (!final && !text) return;
      stream = new MessageStream(run.id, messageId, (ev) => this.#events.append(run.agent_id, run.conversation_id, ev));
      this.#open.set(key, stream);
    }
    stream.feed(text, final);
    if (final) {
      this.#store(stream);
      this.#open.delete(key);
    }
  }

  /** A run ended: close anything it left open, so a cut-off reply still shows what it built. */
  finishRun(runId: string): void {
    for (const [key, stream] of [...this.#open]) {
      if (!key.startsWith(`${runId}:`)) continue;
      stream.finish();
      this.#store(stream);
      this.#open.delete(key);
    }
  }

  #store(stream: MessageStream): void {
    for (const { runId, messageId, state } of stream.blocks()) {
      if (!state.seq) continue; // nothing was built: no row to keep
      const id = `${runId}:${messageId}:${state.index}`;
      const doc = JSON.stringify(state.doc);
      const status = state.doc.status;
      this.#db
        .prepare(
          `INSERT INTO ui_blocks (id, run_id, message_id, block_id, title, status, error, version, doc, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, error = excluded.error,
             version = excluded.version, doc = excluded.doc, updated_at = excluded.updated_at`,
        )
        .run(id, runId, messageId, String(state.index), state.title.slice(0, 80), status, state.failed, state.doc.v, doc, nowIso());
    }
  }
}

/** The stored documents for one message, newest shape only (older ones are converted). */
export function loadUiBlocks(db: Db, messageId: string): StoredUiBlock[] {
  const rows = db.prepare("SELECT block_id, title, status, doc FROM ui_blocks WHERE message_id = ? ORDER BY CAST(block_id AS INTEGER)").all(messageId) as {
    block_id: string;
    title: string;
    status: string;
    doc: string;
  }[];
  const out: StoredUiBlock[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.doc);
    } catch {
      continue;
    }
    const doc = migrateDoc(parsed);
    if (!doc) continue; // written by a newer hub: leave it to that version
    out.push({ blockId: row.block_id, title: row.title, status: row.status === "failed" ? "failed" : row.status === "done" ? "done" : "streaming", doc });
  }
  return out;
}
