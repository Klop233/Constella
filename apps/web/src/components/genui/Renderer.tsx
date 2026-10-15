import { createElement, Fragment, type CSSProperties, type ReactNode } from "react";
import { COMPONENTS, HTML_TAGS, Inline, SVG_TAGS, type Ctx, type Node } from "./components";

// Renders a tree posted by the isolated program. Only known component names and a short list of
// plain HTML/SVG tags become elements; anything else just shows its children. Event handlers arrive
// as {$fn: id} and are turned back into calls to the program; nested elements in props as {$node}.

export type Call = (id: number, args: unknown[]) => void;

/** Values that may cross from an event into the program: plain data only. */
function plain(v: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => plain(x, depth + 1));
  if (typeof v === "object" && !(v instanceof Event) && !("nativeEvent" in (v as object))) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object).slice(0, 100)) o[k] = plain(x, depth + 1);
    return o;
  }
  return null;
}

function resolve(v: unknown, call: Call, render: (n: Node | string) => ReactNode): unknown {
  if (Array.isArray(v)) return v.map((x) => resolve(x, call, render));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$fn === "number") {
      const id = o.$fn;
      return (...args: unknown[]) => call(id, args.map((a) => plain(a)));
    }
    if ("$node" in o) return { $node: o.$node, element: render(o.$node as Node) };
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = resolve(x, call, render);
    return out;
  }
  return v;
}

const STYLE_KEYS = new Set([
  "color", "background", "backgroundColor", "opacity", "fontSize", "fontWeight", "fontStyle", "fontFamily", "textAlign", "textDecoration", "lineHeight", "letterSpacing", "whiteSpace",
  "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "margin", "marginTop", "marginBottom", "marginLeft", "marginRight",
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "display", "flex", "flexDirection", "flexWrap", "alignItems", "justifyContent", "gap", "gridTemplateColumns",
  "border", "borderTop", "borderBottom", "borderLeft", "borderRight", "borderColor", "borderRadius", "borderWidth", "borderStyle", "transform", "transformOrigin", "transition",
  "fill", "stroke", "strokeWidth", "overflow", "position", "top", "left", "right", "bottom", "zIndex", "verticalAlign", "boxShadow", "cursor", "aspectRatio",
]);

/** Inline styles without anything that loads or escapes (url(), expression, fixed positioning over the page). */
function safeStyle(v: unknown): CSSProperties | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!STYLE_KEYS.has(k) || (typeof x !== "string" && typeof x !== "number")) continue;
    if (typeof x === "string" && /url\(|expression|javascript:|@import/i.test(x)) continue;
    if (k === "position" && !["relative", "absolute", "static"].includes(String(x))) continue;
    out[k] = x;
  }
  return out;
}

const SAFE_ATTR = /^(aria-[\w-]+|role|title|alt|width|height|colSpan|rowSpan|viewBox|preserveAspectRatio|xmlns|d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|dx|dy|points|transform|fill|fillOpacity|fillRule|clipRule|stroke|strokeWidth|strokeDasharray|strokeDashoffset|strokeLinecap|strokeLinejoin|strokeOpacity|opacity|textAnchor|dominantBaseline|fontSize|fontWeight|fontFamily|offset|stopColor|stopOpacity|gradientUnits|gradientTransform|markerWidth|markerHeight|refX|refY|orient|markerEnd|markerStart|markerMid|clipPath|mask|pathLength|id|vectorEffect|patternUnits|letterSpacing)$/;

function tagProps(p: Record<string, unknown>, key: number | string): Record<string, unknown> {
  const out: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(p)) {
    if (k === "style") out.style = safeStyle(v);
    else if (k === "className" && typeof v === "string") out.className = v;
    else if (k === "onClick" && typeof v === "function") out.onClick = () => (v as () => void)();
    else if ((k === "href" || k === "xlinkHref") && typeof v === "string" && v.startsWith("#")) out[k] = v;
    else if (SAFE_ATTR.test(k) && (typeof v === "string" || typeof v === "number")) {
      // References inside SVG may point at ids in the same block only.
      if (typeof v === "string" && /url\((?!#)/i.test(v)) continue;
      out[k] = v;
    }
  }
  return out;
}

export function renderTree(tree: unknown, call: Call, ctx: Ctx): ReactNode {
  const render = (n: Node | string, key: number | string = 0): ReactNode => {
    if (typeof n === "string") return <Inline key={key} text={n} />;
    if (!n || typeof n !== "object" || typeof n.t !== "string") return null;
    const kids = Array.isArray(n.c) ? n.c : [];
    const children = kids.length ? kids.map((k, i) => render(k, i)) : undefined;
    if (n.t === "Fragment") return <Fragment key={key}>{children}</Fragment>;
    const Comp = COMPONENTS[n.t];
    if (Comp) {
      const p = resolve(n.p ?? {}, call, (x) => render(x)) as Record<string, any>;
      return <Comp key={key} p={p} kids={kids} ctx={ctx} render={render} children={children} />;
    }
    if (HTML_TAGS.has(n.t) || SVG_TAGS.has(n.t)) {
      const p = resolve(n.p ?? {}, call, (x) => render(x)) as Record<string, unknown>;
      return createElement(n.t, tagProps(p, key), n.t === "br" || n.t === "hr" ? undefined : children);
    }
    return <Fragment key={key}>{children}</Fragment>;
  };
  if (tree === null || tree === undefined) return null;
  return render(tree as Node);
}
