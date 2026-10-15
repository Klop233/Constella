import { z } from "zod";
import { GENUI_SCHEMA, type PropSpec, type PropType } from "../genui.ts";

// The streaming UI DSL: an agent reply may carry a ```ui-json block whose body is JSON — one op per
// line, or any sequence of complete JSON values. The hub reads it while the reply streams, checks
// every op and prop against the one component schema (genui.ts), forwards normalized ops over SSE,
// and the browser builds a normalized tree from them. Nothing the model writes is ever executed:
// components, props and actions are whitelisted, so a hostile reply can at worst draw a wrong card.

/**
 * Hard caps for one block. The hub enforces them while parsing and the browser enforces them again
 * while it builds the tree, so neither a runaway model nor a corrupted stream can exhaust memory.
 */
export const UI_LIMITS = {
  /** Longest single op (the JSON text of one value). */
  op: 24_000,
  /** Longest a whole block's source may be. */
  source: 200_000,
  /** Most ops one block may carry. */
  ops: 800,
  /** Most nodes one block's tree may hold. */
  nodes: 400,
  /** Deepest nesting. */
  depth: 10,
  /** Most children on a single node. */
  children: 120,
  /** Longest ordinary string prop. */
  text: 4_000,
  /** Longest string for props that carry prose (text, code, markdown). */
  longText: 20_000,
  /** Most rows a Table or Chart may carry. Kept below `items` so the row cap can still be reported. */
  rows: 400,
  /** Most entries in any one array or object prop. */
  items: 800,
  /** Most diagnostics kept per block. */
  diagnostics: 20,
  /** Ops that may wait for a gap in the stream before they are dropped. */
  pending: 2_000,
  /** Actions the dispatcher runs for one block per minute. */
  actionsPerMinute: 90,
  /** Longest text an action may send or copy. */
  actionText: 4_000,
  /** Node ids; also used for interaction-state keys. */
  id: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/,
} as const;

const LONG_TEXT_PROPS = new Set(["text", "content", "code", "markdown", "md"]);

// ── actions ──────────────────────────────────────────────

/**
 * A declarative interaction. A prop that would be a callback in a component program (onClick,
 * onChange, onSubmit) holds one of these instead; the Action Dispatcher
 * (apps/web/src/lib/streamui/actions.ts) is the only code that runs them. Only `send` and `submit`
 * reach the agent — everything else stays in the browser.
 */
export const UIActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    text: z.string().max(UI_LIMITS.actionText).optional(),
    /** Interaction-state keys whose current values are appended to the message. */
    from: z.array(z.string().max(64)).max(24).optional(),
    /** Ask the owner to confirm before sending (side effects, money, deletion). */
    confirm: z.boolean().optional(),
  }),
  z.object({ type: z.literal("copy"), text: z.string().max(UI_LIMITS.longText) }),
  z.object({ type: z.literal("open"), url: z.string().max(2_000) }),
  z.object({ type: z.literal("state"), key: z.string().max(64), value: z.unknown().optional() }),
  z.object({ type: z.literal("submit"), form: z.string().max(64).optional(), prefix: z.string().max(200).optional(), confirm: z.boolean().optional() }),
  z.object({ type: z.literal("reset") }),
]);
export type UIAction = z.infer<typeof UIActionSchema>;
export type UIActionType = UIAction["type"];

const ACTION_TYPES = new Set<string>(["send", "copy", "open", "state", "submit", "reset"]);

/**
 * Adds a diagnostic once, up to the cap. Deduped because a single repeated mistake (a prop the model
 * keeps writing wrong) must not fill the list and crowd out the ones that matter.
 */
export function pushIssue(issues: string[], message: string): void {
  if (issues.length < UI_LIMITS.diagnostics && !issues.includes(message)) issues.push(message);
}

/** An action's text is capped rather than refused: a long message is still a message. */
function capActionText(s: string): string {
  return s.length > UI_LIMITS.actionText ? s.slice(0, UI_LIMITS.actionText) : s;
}

function capString(s: string, prop: string): string {
  return s.length > (LONG_TEXT_PROPS.has(prop) ? UI_LIMITS.longText : UI_LIMITS.text) ? s.slice(0, LONG_TEXT_PROPS.has(prop) ? UI_LIMITS.longText : UI_LIMITS.text) : s;
}

/**
 * The action a prop holds, or null when it isn't one. Bare strings and the short objects a model
 * reaches for (`{"send": "…"}`, `{"copy": "…"}`, `{"open": "…"}`) are accepted as shorthands.
 */
export function normalizeAction(v: unknown): UIAction | null {
  if (typeof v === "string") {
    const text = v.trim();
    return text ? { type: "send", text: capActionText(text) } : null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.type === "string") {
    if (!ACTION_TYPES.has(o.type)) return null;
    // Truncate before validating, so one over-long message doesn't cost the whole action.
    const candidate = o.type === "send" && typeof o.text === "string" ? { ...o, text: capActionText(o.text) } : o;
    const parsed = UIActionSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
  const from = Array.isArray(o.from) ? o.from.filter((x): x is string => typeof x === "string").slice(0, 24) : undefined;
  const confirm = o.confirm === true ? { confirm: true } : {};
  if (typeof o.send === "string") return { type: "send", text: capActionText(o.send), ...(from?.length ? { from } : {}), ...confirm };
  if (typeof o.copy === "string") return { type: "copy", text: capString(o.copy, "text") };
  if (typeof o.open === "string") return { type: "open", url: o.open.slice(0, 2_000) };
  const state = o.state;
  if (state && typeof state === "object" && !Array.isArray(state) && typeof (state as Record<string, unknown>).key === "string") {
    return { type: "state", key: String((state as Record<string, unknown>).key).slice(0, 64), value: (state as Record<string, unknown>).value };
  }
  return null;
}

/** Only plain http(s) links without embedded credentials are ever opened. */
export function safeUrl(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 2_000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ── props ────────────────────────────────────────────────

const TYPE_NAME: Record<PropType, string> = {
  string: "文字",
  number: "数字",
  boolean: "true/false",
  array: "数组",
  object: "对象",
  function: "动作",
  node: "文字或组件",
  any: "任意值",
};

/** True for props that hold an action (declared as `function` in the component schema). */
export function isActionProp(spec: PropSpec): boolean {
  return Array.isArray(spec.type) ? spec.type.includes("function") : spec.type === "function";
}

/** Deepest value nesting a prop may carry, and the entries allowed per array/object. */
function capValue(v: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (typeof v === "string") return v.length > UI_LIMITS.text ? v.slice(0, UI_LIMITS.text) : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.slice(0, UI_LIMITS.items).map((x) => capValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, UI_LIMITS.items)) out[k.slice(0, 64)] = capValue(x, depth + 1);
    return out;
  }
  return null;
}

function coerce(v: unknown, type: PropType): unknown {
  switch (type) {
    case "any":
      return v;
    case "string":
      return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
    case "number": {
      if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return undefined;
    }
    case "boolean":
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    case "array":
      return Array.isArray(v) ? v : undefined;
    case "object":
      return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
    case "node":
      return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
    case "function":
      return undefined; // handled by the action branch
  }
}

/** A short description of what arrived, for diagnostics. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  if (typeof v === "object") return "对象";
  if (typeof v === "string") return `「${v.slice(0, 24)}」`;
  return String(v);
}

/**
 * Checks one node's props against the component schema and returns the values worth keeping.
 * Nothing is fatal: values that can be converted are converted ("3" → 3), values that can't are
 * dropped with a diagnostic, unknown props are dropped. `null` means the type isn't registered.
 */
export function validateProps(type: string, raw: unknown, nodeId: string, issues: string[]): Record<string, unknown> | null {
  const spec = GENUI_SCHEMA[type];
  if (!spec) {
    pushIssue(issues, `未知组件 ${type || "(空)"}（已只显示它的内容）`);
    return null;
  }
  const props: Record<string, unknown> = {};
  if (raw === undefined || raw === null) return props;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    pushIssue(issues, `${type} 的 props 应该是对象`);
    return props;
  }
  const names = new Map<string, { name: string; spec: PropSpec }>();
  for (const [k, ps] of Object.entries(spec.props)) {
    names.set(k, { name: k, spec: ps });
    for (const a of ps.alias ?? []) names.set(a, { name: k, spec: ps });
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "children" || v === null || v === undefined) continue;
    const found = names.get(k);
    if (!found) {
      // `text` is accepted everywhere: components that have no text prop render it as their content.
      if (k === "text" && typeof v === "string") props.text = capString(v, "text");
      else pushIssue(issues, `${type} 没有属性 ${k}`);
      continue;
    }
    const { name, spec: ps } = found;
    if (isActionProp(ps)) {
      const action = normalizeAction(v);
      if (action) props[name] = action;
      else pushIssue(issues, `${type} 的 ${name} 不是可识别的动作`);
      continue;
    }
    const types = Array.isArray(ps.type) ? ps.type : [ps.type];
    let value: unknown;
    for (const t of types) {
      const c = coerce(v, t);
      if (c === undefined) continue;
      if (ps.values && typeof c === "string" && !ps.values.includes(c)) {
        pushIssue(issues, `${type} 的 ${name} 不能是「${c}」（可选 ${ps.values.filter((x) => x !== "default").join(" / ")}）`);
        value = undefined;
        break;
      }
      value = c;
      break;
    }
    if (value === undefined) {
      pushIssue(issues, `${type} 的 ${name} 应该是${types.map((t) => TYPE_NAME[t]).join("或")}，收到的是${describe(v)}`);
      continue;
    }
    props[name] = capValue(value);
  }
  for (const [k, ps] of Object.entries(spec.props)) {
    if (!ps.required || props[k] !== undefined) continue;
    if ((ps.alias ?? []).some((a) => props[a] !== undefined)) continue;
    pushIssue(issues, `${type} 缺少 ${k}`);
  }
  void nodeId;
  return props;
}

/** How many rows a Table or Chart prop may carry; anything longer is truncated with a diagnostic. */
export function capRows(type: string, props: Record<string, unknown>, issues: string[]): void {
  if (type !== "Table" && type !== "Chart" && type !== "List" && type !== "Timeline" && type !== "Quiz") return;
  for (const key of ["rows", "data", "items", "questions", "series"]) {
    const v = props[key];
    if (Array.isArray(v) && v.length > UI_LIMITS.rows) {
      props[key] = v.slice(0, UI_LIMITS.rows);
      pushIssue(issues, `${type} 的 ${key} 只保留前 ${UI_LIMITS.rows} 项`);
    }
  }
}
