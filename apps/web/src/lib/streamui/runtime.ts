import { UI_LIMITS, docNodeCount, safeUrl, type UIAction, type UIChild, type UIDoc, type UINode, type UIStatus } from "@constella/protocol";
import { toast } from "../../components/ui";
import { collectFields, enclosingForm, textOf } from "./inputs";

// One streaming UI block's live state: the tree the hub built, the values the owner has changed in
// it, and the only code allowed to act on either. Components read through `useSyncExternalStore`, so
// an op that touches one node re-renders that node and nothing else — which is what keeps a long
// reply streaming smoothly.
//
// The interaction state is deliberately separate from the tree: the model owns the tree, the owner
// owns the values, and an incremental update from the model can't clear what the owner typed.

type Listener = () => void;

export interface NodeSnapshot {
  node: UINode | undefined;
  /** What the owner has set on this node, if anything. */
  value: unknown;
}

export interface RootsSnapshot {
  roots: UIChild[];
  status: UIStatus;
  issues: string[];
  count: number;
}

export interface RuntimeOptions {
  doc: UIDoc;
  /** Send a message to the agent as the owner. */
  send: (text: string) => void;
  /** Record a problem the source view should show. */
  report?: (message: string) => void;
}

/** The most actions one block may run per minute (a runaway auto-clicker can't hammer the agent). */
const ACTION_WINDOW_MS = 60_000;

export class UiBlockRuntime {
  #doc: UIDoc;
  #values: Record<string, unknown> = {};
  #nodeListeners = new Map<string, Set<Listener>>();
  #rootListeners = new Set<Listener>();
  #anyListeners = new Set<Listener>();
  #nodeSnaps = new Map<string, NodeSnapshot>();
  #rootsSnap: RootsSnapshot | null = null;
  #recent: number[] = [];
  #send: (text: string) => void;
  #report: ((message: string) => void) | undefined;

  constructor(opts: RuntimeOptions) {
    this.#doc = opts.doc;
    this.#send = opts.send;
    this.#report = opts.report;
  }

  get doc(): UIDoc {
    return this.#doc;
  }

  /** A new tree from the hub (or from re-reading the reply). Only changed nodes are woken up. */
  setDoc(doc: UIDoc): void {
    if (doc === this.#doc) return;
    const prev = this.#doc;
    this.#doc = doc;
    for (const id of new Set([...Object.keys(prev.nodes), ...Object.keys(doc.nodes)])) {
      if (prev.nodes[id] === doc.nodes[id]) continue;
      this.#nodeSnaps.delete(id);
      for (const fn of this.#nodeListeners.get(id) ?? []) fn();
    }
    if (prev.roots !== doc.roots || prev.status !== doc.status || prev.issues !== doc.issues || docNodeCount(prev) !== docNodeCount(doc)) this.#notifyRoots();
    this.#notifyAny();
  }

  /** Fires for any change to the tree or to the owner's values (used to persist what they typed). */
  onChange(fn: Listener): () => void {
    this.#anyListeners.add(fn);
    return () => this.#anyListeners.delete(fn);
  }

  #notifyAny(): void {
    for (const fn of this.#anyListeners) fn();
  }

  subscribeNode(id: string, fn: Listener): () => void {
    let set = this.#nodeListeners.get(id);
    if (!set) {
      set = new Set();
      this.#nodeListeners.set(id, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.#nodeListeners.delete(id);
    };
  }

  /** Stable between changes, so `useSyncExternalStore` can tell "nothing happened" from "redraw". */
  nodeSnapshot(id: string): NodeSnapshot {
    let snap = this.#nodeSnaps.get(id);
    if (!snap) {
      snap = { node: this.#doc.nodes[id], value: this.#values[id] };
      this.#nodeSnaps.set(id, snap);
    }
    return snap;
  }

  subscribeRoots(fn: Listener): () => void {
    this.#rootListeners.add(fn);
    return () => this.#rootListeners.delete(fn);
  }

  rootsSnapshot(): RootsSnapshot {
    this.#rootsSnap ??= { roots: this.#doc.roots, status: this.#doc.status, issues: this.#doc.issues, count: docNodeCount(this.#doc) };
    return this.#rootsSnap;
  }

  #notifyRoots(): void {
    this.#rootsSnap = null;
    for (const fn of this.#rootListeners) fn();
  }

  // ── interaction state ──────────────────────────────────

  value(id: string): unknown {
    return this.#values[id];
  }

  values(): Record<string, unknown> {
    return this.#values;
  }

  setValue(id: string, value: unknown): void {
    if (Object.is(this.#values[id], value)) return;
    this.#values = { ...this.#values, [id]: value };
    this.#nodeSnaps.delete(id);
    for (const fn of this.#nodeListeners.get(id) ?? []) fn();
    this.#notifyAny();
  }

  clearValues(): void {
    if (!Object.keys(this.#values).length) return;
    this.#values = {};
    this.#nodeSnaps.clear();
    for (const set of this.#nodeListeners.values()) for (const fn of set) fn();
    this.#notifyAny();
  }

  /** Restores what the owner had typed (a refresh, or coming back to the conversation). */
  restoreValues(data: Record<string, unknown> | undefined): void {
    if (!data || !Object.keys(data).length) return;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data).slice(0, UI_LIMITS.nodes)) next[k.slice(0, 64)] = v;
    this.#values = next;
    this.#nodeSnaps.clear();
    for (const set of this.#nodeListeners.values()) for (const fn of set) fn();
    this.#notifyAny();
  }

  // ── actions ────────────────────────────────────────────

  /** The only way a declarative action runs; the model can never hand the browser a callback. */
  dispatch(action: UIAction, nodeId: string): void {
    if (!this.#allow()) {
      toast("这个界面操作得太频繁了，稍等一下再试", "danger");
      return;
    }
    switch (action.type) {
      case "send": {
        const text = this.#compose(action.text, action.from);
        if (!text) return;
        this.#toAgent(text, action.confirm);
        return;
      }
      case "copy": {
        const text = action.text.slice(0, UI_LIMITS.longText);
        void navigator.clipboard.writeText(text).then(
          () => toast("已复制"),
          () => toast("复制失败", "danger"),
        );
        return;
      }
      case "open": {
        const url = safeUrl(action.url);
        if (!url) {
          this.#report?.("拒绝打开一个不安全的链接");
          toast("这个链接不能打开", "danger");
          return;
        }
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      case "state":
        this.setValue(action.key, action.value);
        return;
      case "submit": {
        const formId = action.form ?? enclosingForm(this.#doc, nodeId) ?? nodeId;
        const fields = collectFields(this.#doc, formId, this.#values);
        if (!fields.length) {
          toast("这个表单还没有可提交的内容", "danger");
          return;
        }
        const body = fields.map((f) => `${f.label}：${textOf(f.value)}`).join("；");
        const prefix = action.prefix ?? "提交：";
        this.#toAgent(`${prefix}${body}`.slice(0, UI_LIMITS.actionText), action.confirm);
        return;
      }
      case "reset":
        this.clearValues();
        return;
    }
  }

  #compose(text: string | undefined, from: string[] | undefined): string {
    const parts: string[] = [];
    if (text) parts.push(text);
    for (const key of from ?? []) {
      const value = key in this.#values ? this.#values[key] : undefined;
      if (value === undefined || value === "") continue;
      const node = this.#doc.nodes[key];
      const label = node ? (typeof node.props.label === "string" && node.props.label.trim() ? node.props.label.trim() : key) : key;
      parts.push(`${label}：${textOf(value)}`);
    }
    return parts.join("\n").slice(0, UI_LIMITS.actionText);
  }

  /**
   * Handing something back to the agent. Only a real click or key press counts, so a reply that
   * renders a button can't send messages on its own.
   */
  #toAgent(text: string, confirm?: boolean): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    if (confirm && !window.confirm(`确定要发送吗？\n\n${trimmed.slice(0, 300)}`)) return;
    this.#send(trimmed);
  }

  #allow(): boolean {
    const now = Date.now();
    this.#recent = this.#recent.filter((t) => now - t < ACTION_WINDOW_MS);
    if (this.#recent.length >= UI_LIMITS.actionsPerMinute) return false;
    this.#recent.push(now);
    return true;
  }
}
