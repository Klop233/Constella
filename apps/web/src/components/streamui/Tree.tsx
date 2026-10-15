import { GENUI_SCHEMA, isActionProp, UI_LIMITS, type UIAction, type UIDoc, type UINode } from "@constella/protocol";
import { memo, useCallback, useSyncExternalStore, type ReactNode } from "react";
import { bindingOf } from "../../lib/streamui/inputs";
import type { UiBlockRuntime } from "../../lib/streamui/runtime";
import { COMPONENTS, Inline, type Ctx, type Node } from "../genui/components";

// Renders a declarative UI tree with the platform's own components. Two things keep it cheap while a
// reply streams: a node's object identity only changes when that node changed (doc.ts guarantees it),
// and every node subscribes to just itself — so an op that fills one table cell redraws one cell.

/** A materialized node carries the id it came from, so a component that inspects its raw kids can
 *  still hand rendering back to the declarative tree instead of drawing a detached copy. */
export interface LiveNode extends Node {
  __id: string;
}

/** The shape a component may inspect, with no bindings attached: used for `kids` (labels, structure). */
function materializeStatic(doc: UIDoc, id: string, seen: Set<string>): LiveNode | null {
  const node = doc.nodes[id];
  if (!node || seen.has(id) || seen.size > UI_LIMITS.nodes) return null;
  seen.add(id);
  const children: (LiveNode | string)[] = [];
  for (const child of node.children) {
    if (typeof child === "string") {
      const built = materializeStatic(doc, child, seen);
      if (built) children.push(built);
    } else children.push(child.text);
  }
  return { t: node.type, p: node.props, c: children, __id: id };
}

/**
 * The props a component receives: the model's props, with every action prop replaced by a function
 * that goes through the Action Dispatcher, and every input bound to the block's interaction state so
 * the owner's typing survives a later update from the model.
 */
function propsFor(node: UINode, value: unknown, runtime: UiBlockRuntime, _ctx: Ctx): Record<string, any> {
  const spec = GENUI_SCHEMA[node.type];
  const p: Record<string, any> = { ...node.props };
  if (!spec) return p;
  const binding = bindingOf(node.type);
  for (const [name, propSpec] of Object.entries(spec.props)) {
    if (!isActionProp(propSpec)) continue;
    const action = p[name];
    if (name === "onChange" && binding) continue; // bound below, so the value is always recorded
    if (action && typeof action === "object") p[name] = () => runtime.dispatch(action as UIAction, node.id);
    else delete p[name];
  }
  if (binding) {
    const declared = node.props.onChange;
    p.onChange = (...args: unknown[]) => {
      runtime.setValue(node.id, args[0]);
      if (declared && typeof declared === "object") runtime.dispatch(declared as UIAction, node.id);
    };
    const initial = p[binding.value] !== undefined ? p[binding.value] : p[binding.initial];
    if (initial !== undefined && p[binding.initial] === undefined) p[binding.initial] = initial;
    p[binding.value] = value !== undefined ? value : initial;
  }
  // A button-like component the model gave a `send` / `copy` / `href` instead of an onClick: route it
  // through the dispatcher too, so every side effect an interface can have goes through one place
  // (rate limit, URL check, confirmation) rather than through the component's own shortcut.
  if (spec.props.onClick && p.onClick === undefined) {
    const send = typeof p.send === "string" ? p.send : undefined;
    const copy = typeof p.copy === "string" ? p.copy : undefined;
    const href = typeof p.href === "string" ? p.href : undefined;
    if (send) p.onClick = () => runtime.dispatch({ type: "send", text: send }, node.id);
    else if (copy) p.onClick = () => runtime.dispatch({ type: "copy", text: copy }, node.id);
    else if (href) p.onClick = () => runtime.dispatch({ type: "open", url: href }, node.id);
  }
  // A form submits by default: it gathers the fields inside it and sends them to the agent.
  if (node.type === "Form" && !p.onSubmit) {
    p.onSubmit = () =>
      runtime.dispatch(
        {
          type: "submit",
          form: node.id,
          ...(typeof node.props.prefix === "string" ? { prefix: node.props.prefix } : {}),
          ...(node.props.confirm === true ? { confirm: true } : {}),
        },
        node.id,
      );
  }
  return p;
}

function renderKid(k: Node | string | null, key: number | string, runtime: UiBlockRuntime, ctx: Ctx): ReactNode {
  if (k === null || k === undefined) return null;
  if (typeof k === "string") return <Inline key={key} text={k} />;
  const id = (k as LiveNode).__id;
  if (!id) return null;
  return <NodeView key={key} id={id} runtime={runtime} ctx={ctx} />;
}

/** One node: subscribes to itself, so it redraws when it — and only it — changes. */
export const NodeView = memo(function NodeView({ id, runtime, ctx }: { id: string; runtime: UiBlockRuntime; ctx: Ctx }) {
  const snapshot = useSyncExternalStore(
    useCallback((fn: () => void) => runtime.subscribeNode(id, fn), [runtime, id]),
    useCallback(() => runtime.nodeSnapshot(id), [runtime, id]),
    useCallback(() => runtime.nodeSnapshot(id), [runtime, id]),
  );
  const node = snapshot.node;
  if (!node) return null;
  const doc = runtime.doc;
  const spec = GENUI_SCHEMA[node.type];
  const p = propsFor(node, snapshot.value, runtime, ctx);
  const seen = new Set<string>([id]);
  const kids = node.children.map((child) => (typeof child === "string" ? materializeStatic(doc, child, seen) : child.text)).filter((k): k is LiveNode | string => k !== null);
  // A component that has no `text` prop of its own renders `props.text` as its content (the model
  // writes prose that way); the program host hands it over as a child element, and so does this one.
  // `children` stays undefined when there is nothing, which is what Button and Link expect before
  // falling back to their own label.
  const inlineText = spec && !spec.props.text && typeof node.props.text === "string" ? node.props.text : null;
  const children = kids.length ? kids.map((k, i) => renderKid(k, i, runtime, ctx)) : inlineText !== null ? <Inline text={inlineText} /> : undefined;
  const Comp = COMPONENTS[node.type];
  if (!Comp) {
    // An unknown component (a newer hub, or a model inventing one) shows its content instead of breaking the reply.
    return (
      <div className="min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-[13px] space-y-1.5">
        <div className="text-xs text-muted">
          还不支持组件 <span className="font-mono">{node.type}</span>，下面是它的内容
        </div>
        {children}
      </div>
    );
  }
  return <Comp p={p} kids={kids} ctx={ctx} render={(k, key) => renderKid(k, key ?? 0, runtime, ctx)} children={children} />;
});

/** The whole tree of one block. */
export function UiTree({ runtime, ctx }: { runtime: UiBlockRuntime; ctx: Ctx }) {
  const snapshot = useSyncExternalStore(
    useCallback((fn: () => void) => runtime.subscribeRoots(fn), [runtime]),
    useCallback(() => runtime.rootsSnapshot(), [runtime]),
    useCallback(() => runtime.rootsSnapshot(), [runtime]),
  );
  return (
    <div className="genui min-w-0 flex flex-col gap-3 font-display">
      {snapshot.roots.map((child, i) =>
        typeof child === "string" ? <NodeView key={i} id={child} runtime={runtime} ctx={ctx} /> : <div key={i} className="min-w-0 text-sm leading-relaxed"><Inline text={child.text} /></div>,
      )}
    </div>
  );
}
