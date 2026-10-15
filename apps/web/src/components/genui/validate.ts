import { GENUI_HTML_TAGS, GENUI_SCHEMA, GENUI_SVG_TAGS, type PropSpec, type PropType } from "@constella/protocol";

// The validator between the program and the renderer: every tree the program posts is checked
// against the component schema before it's shown. Like ChatGPT's compiler, it never refuses a tree:
// props it can safely convert are converted ("3" → 3), props that are wrong are dropped, and each
// problem becomes a diagnostic that the source view lists and "让 agent 修复" passes on.

export interface TreeNode {
  t: string;
  p: Record<string, unknown>;
  c: (TreeNode | string)[];
}

const TAGS = new Set<string>([...GENUI_HTML_TAGS, ...GENUI_SVG_TAGS]);
const MAX_DIAGNOSTICS = 20;

const isFn = (v: unknown) => !!v && typeof v === "object" && typeof (v as { $fn?: unknown }).$fn === "number";
const isNode = (v: unknown) => !!v && typeof v === "object" && "$node" in (v as object);

/** The value converted to `type`, or undefined if it can't be. */
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
      return v && typeof v === "object" && !Array.isArray(v) && !isFn(v) && !isNode(v) ? v : undefined;
    case "function":
      return isFn(v) ? v : undefined;
    case "node":
      return typeof v === "string" || isNode(v) ? v : typeof v === "number" ? String(v) : undefined;
  }
}

const TYPE_NAME: Record<PropType, string> = { string: "文字", number: "数字", boolean: "true/false", array: "数组", object: "对象", function: "函数", node: "文字或组件", any: "任意值" };

function checkProp(component: string, name: string, v: unknown, spec: PropSpec, out: string[]): unknown {
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  for (const t of types) {
    const c = coerce(v, t);
    if (c === undefined) continue;
    if (spec.values && typeof c === "string" && !spec.values.includes(c)) {
      out.push(`${component} 的 ${name} 不能是「${c}」（可选 ${spec.values.filter((x) => x !== "default").join(" / ")}）`);
      return undefined;
    }
    return c;
  }
  out.push(`${component} 的 ${name} 应该是${types.map((t) => TYPE_NAME[t]).join("或")}，收到的是${isFn(v) ? "函数" : Array.isArray(v) ? "数组" : typeof v === "object" ? "对象" : typeof v === "string" ? `「${String(v).slice(0, 20)}」` : String(v)}`);
  return undefined;
}

export function validateTree(tree: unknown): { tree: TreeNode | null; diagnostics: string[] } {
  const out: string[] = [];
  const visit = (n: unknown, parent: string | null): TreeNode | string | null => {
    if (typeof n === "string") return n;
    if (!n || typeof n !== "object" || typeof (n as TreeNode).t !== "string") return null;
    const node = n as TreeNode;
    const kids = Array.isArray(node.c) ? node.c : [];
    const children = kids.map((k) => visit(k, node.t === "Fragment" ? parent : node.t)).filter((k): k is TreeNode | string => k !== null);
    const props: Record<string, unknown> = {};
    const spec = GENUI_SCHEMA[node.t];
    if (node.t === "Fragment") return { t: "Fragment", p: {}, c: children };
    if (!spec) {
      if (TAGS.has(node.t)) return { t: node.t, p: deepNodes(node.p ?? {}, visit, node.t) as Record<string, unknown>, c: children };
      out.push(/^[A-Z]/.test(node.t) ? `未知组件 ${node.t}（已只显示它的内容）` : `不支持的标签 <${node.t}>（已只显示它的内容）`);
      return { t: "Fragment", p: {}, c: children };
    }
    if (spec.parent && parent !== spec.parent) out.push(`${node.t} 要放在 ${spec.parent} 里`);
    const names = new Map<string, PropSpec>();
    for (const [k, ps] of Object.entries(spec.props)) {
      names.set(k, ps);
      for (const a of ps.alias ?? []) names.set(a, ps);
    }
    for (const [k, v] of Object.entries(node.p ?? {})) {
      if (k === "key" || k === "children" || v === null || v === undefined) continue;
      const ps = names.get(k);
      if (!ps) {
        out.push(`${node.t} 没有属性 ${k}`);
        continue;
      }
      const c = checkProp(node.t, k, v, ps, out);
      if (c !== undefined) props[k] = deepNodes(c, visit, node.t);
    }
    for (const [k, ps] of Object.entries(spec.props)) {
      if (ps.required && props[k] === undefined && !(ps.alias ?? []).some((a) => props[a] !== undefined) && !(k === "value" && children.length) && !(k === "code" && children.length) && !(k === "text" && children.length)) {
        out.push(`${node.t} 缺少 ${k}`);
      }
    }
    return { t: node.t, p: props, c: children };
  };
  const root = visit(tree, null);
  const diagnostics = [...new Set(out)].slice(0, MAX_DIAGNOSTICS);
  return { tree: root === null ? null : typeof root === "string" ? { t: "Fragment", p: {}, c: [root] } : root, diagnostics };
}

/** Elements passed as props ({$node}) are validated like children. */
function deepNodes(v: unknown, visit: (n: unknown, parent: string | null) => TreeNode | string | null, parent: string): unknown {
  if (Array.isArray(v)) return v.map((x) => deepNodes(x, visit, parent));
  if (isNode(v)) return { $node: visit((v as { $node: unknown }).$node, parent) };
  if (v && typeof v === "object" && !isFn(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = deepNodes(x, visit, parent);
    return o;
  }
  return v;
}
