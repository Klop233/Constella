import { emptyDoc, isUiOp, reduceOps, scanJsonValues, type UIDoc, type UIOpEntry, type UIStatus } from "@constella/protocol";

// Documents for streaming UI blocks, rebuilt from the `ui.op` events the hub sends. Applying a
// block's ops again is a no-op (the reducer skips ops it has already applied) and hands back the same
// object, so folding a run's events on every render is cheap and — more importantly — keeps each
// node's identity, which is what lets the renderer memoize whole subtrees.

/** What one reply carries: the tree of each block, and how each block is doing. */
export interface MessageUi {
  docs: Record<string, UIDoc>;
  status: Record<string, UIStatus>;
  issues: Record<string, string[]>;
}

export function emptyMessageUi(): MessageUi {
  return { docs: {}, status: {}, issues: {} };
}

const MAX_CACHED = 300;
const cache = new Map<string, UIDoc>();

function remember(key: string, doc: UIDoc): UIDoc {
  cache.delete(key);
  cache.set(key, doc);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return doc;
}

/** Folds one `ui.op` event into its block's document. */
export function applyUiOps(key: string, from: number, ops: unknown[]): UIDoc {
  const entries: UIOpEntry[] = [];
  for (let i = 0; i < ops.length; i++) entries.push({ seq: from + i, op: ops[i] });
  return remember(key, reduceOps(cache.get(key) ?? emptyDoc(), entries));
}

export function uiDocFor(key: string): UIDoc | undefined {
  return cache.get(key);
}

/**
 * The same document, built straight from the reply text. Used when a block has no ops in the event
 * stream (a pruned history, a restored conversation, a device that missed them): the reply itself is
 * the durable record, so the interface can always be rebuilt from it.
 */
export function buildDocFromSource(source: string): UIDoc {
  const scan = scanJsonValues(source, 0);
  const entries: UIOpEntry[] = [];
  let seq = 0;
  for (const value of scan.values) {
    if (!isUiOp(value)) continue; // same rule as the hub, so op numbering stays identical
    entries.push({ seq: ++seq, op: value });
  }
  return reduceOps(emptyDoc(), entries);
}
