import type { UIDoc, UINode } from "@constella/protocol";

// Which prop of a component carries its current value, and which one its initial value. The DSL
// always gives the model's value as the *initial* one (`defaultValue`); what the owner types lives in
// the block's interaction state instead, so a later `update` op from the model can never wipe it.

export interface ValueBinding {
  /** The prop the component reads its current value from. */
  value: string;
  /** The prop the model writes the starting value into. */
  initial: string;
}

const BINDINGS: Record<string, ValueBinding> = {
  Slider: { value: "value", initial: "defaultValue" },
  NumberInput: { value: "value", initial: "defaultValue" },
  Input: { value: "value", initial: "defaultValue" },
  TextArea: { value: "value", initial: "defaultValue" },
  Select: { value: "value", initial: "defaultValue" },
  Segmented: { value: "value", initial: "defaultValue" },
  Choice: { value: "value", initial: "defaultValue" },
  Switch: { value: "checked", initial: "defaultChecked" },
  Checkbox: { value: "checked", initial: "defaultChecked" },
};

export const FIELD_TYPES = new Set(Object.keys(BINDINGS));

export function bindingOf(type: string): ValueBinding | null {
  return BINDINGS[type] ?? null;
}

/** A field of a form: what it is called and what it currently holds. */
export interface Field {
  id: string;
  label: string;
  value: unknown;
}

function labelOf(node: UINode): string {
  const p = node.props;
  for (const key of ["label", "title", "summary", "name"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 60);
  }
  return node.id;
}

function textOf(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (Array.isArray(v)) return v.map((x) => textOf(x)).filter(Boolean).join("、");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const label = o.label ?? o.value ?? o.name;
    return label === undefined ? JSON.stringify(v).slice(0, 200) : textOf(label);
  }
  return String(v).slice(0, 200);
}

/** The value a field holds: what the owner changed it to, else the model's initial value. */
export function fieldValue(node: UINode, values: Record<string, unknown>): unknown {
  if (node.id in values) return values[node.id];
  const binding = bindingOf(node.type);
  if (!binding) return undefined;
  const p = node.props;
  return p[binding.value] ?? p[binding.initial];
}

/**
 * The fields inside `rootId`, in tree order, with the owner's current values. Used by the `submit`
 * action, so a form sends what is actually on screen rather than what the model first wrote.
 */
export function collectFields(doc: UIDoc, rootId: string, values: Record<string, unknown>, limit = 60): Field[] {
  const out: Field[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (out.length >= limit || seen.has(id)) return;
    seen.add(id);
    const node = doc.nodes[id];
    if (!node) return;
    if (FIELD_TYPES.has(node.type)) {
      const value = fieldValue(node, values);
      if (value !== undefined && value !== "" && !(Array.isArray(value) && !value.length)) out.push({ id, label: labelOf(node), value });
    }
    for (const child of node.children) if (typeof child === "string") walk(child);
  };
  walk(rootId);
  return out;
}

/** The Form a node sits in, if any: `submit` uses it when the action doesn't name one. */
export function enclosingForm(doc: UIDoc, nodeId: string): string | null {
  let cur: string | null = doc.nodes[nodeId]?.parent ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node: UINode | undefined = doc.nodes[cur];
    if (!node) return null;
    if (node.type === "Form") return cur;
    cur = node.parent;
  }
  return null;
}

export { textOf };
