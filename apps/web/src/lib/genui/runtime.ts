// The isolated side of a component block. A hidden, sandboxed iframe (opaque origin, no network by CSP)
// starts a Web Worker and relays messages; the worker runs the agent's compiled program with a tiny
// hooks runtime and posts back plain trees. Nothing the agent writes ever touches the page's DOM:
// the page renders the trees with its own components (Renderer.tsx), and event handlers stay in the
// worker, referenced by number. If a Worker can't be started, the same runtime runs in the frame.
//
// Host → runtime:  {type:"load", code, slots}   (again while streaming: new program, same state)
//                  {type:"call", id, args}       (an event handler, by the id in the last tree)
// Runtime → host:  {type:"tree", tree} · {type:"state", slots} · {type:"idle"}
//                  {type:"send"|"copy"|"open", …} · {type:"error", message, phase}

export const BRIDGE = "constella-genui";

/** Component names the program may use; anything else that's capitalized must be its own function. */
export const COMPONENTS = [
  "Box", "Row", "Col", "Stack", "Grid", "Card", "Divider", "Spacer", "Caption",
  "Text", "Heading", "Markdown", "Code", "Icon", "Badge", "Kbd",
  "Stat", "Progress", "Table", "Chart", "KeyValue", "List", "Item", "Flow", "Node", "Timeline", "Event",
  "Steps", "Step", "Tabs", "Tab", "Accordion", "Details", "Callout", "Quiz", "Image", "Suggestions",
  "Slider", "NumberInput", "Input", "TextArea", "Select", "Segmented", "Switch", "Checkbox", "Choice", "Button", "Link",
] as const;

/** The worker program: everything the agent's code can see. Kept as plain JS (it runs in the frame). */
export const RUNTIME = String.raw`
function __genui(post, listen) {
  "use strict";
  const COMPONENTS = __COMPONENTS__;
  for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection"]) {
    try { delete self[k]; } catch {}
    try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch {}
  }

  const Fragment = "Fragment";
  const scope = { Fragment };
  for (const c of COMPONENTS) scope[c] = c;

  // Elements: {$el, t, p, c}. Text is a string; numbers become strings; null/false/true vanish.
  function h(t, p, ...c) {
    const props = p || {};
    const kids = c.length ? c : props.children !== undefined ? [props.children] : [];
    return { $el: 1, t, p: props, c: kids };
  }

  let program = null;
  let slots = [];
  let hook = 0;
  let effects = [];
  let fns = new Map(), prevFns = new Map();
  let pending = false, rendering = false, lastSlots = "[]";

  function useState(init) {
    const i = hook++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
    const set = (v) => {
      const next = typeof v === "function" ? v(slots[i]) : v;
      if (Object.is(next, slots[i])) return;
      slots[i] = next;
      schedule();
    };
    return [slots[i], set];
  }
  const memo = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((x, j) => Object.is(x, b[j]));
  function useMemo(fn, deps) {
    const i = hook++;
    const m = memo[i];
    if (m && deps && same(m.deps, deps)) return m.v;
    const v = fn();
    memo[i] = { v, deps };
    return v;
  }
  const useCallback = (fn, deps) => useMemo(() => fn, deps);
  const refs = [];
  function useRef(init) { const i = hook++; if (!refs[i]) refs[i] = { current: init }; return refs[i]; }
  const effectDeps = [];
  const cleanups = [];
  function useEffect(fn, deps) {
    const i = hook++;
    if (deps && effectDeps[i] && same(effectDeps[i], deps)) return;
    effectDeps[i] = deps;
    effects.push(() => { if (cleanups[i]) try { cleanups[i](); } catch {} const c = fn(); cleanups[i] = typeof c === "function" ? c : null; });
  }
  function useInterval(fn, ms) {
    const ref = useRef(fn); ref.current = fn;
    useEffect(() => { if (!ms || ms < 30) return; const t = setInterval(() => ref.current(), ms); return () => clearInterval(t); }, [ms]);
  }

  // Host actions. Sending is checked again on the page (it needs the owner's own click).
  const send = (text) => { if (text != null && String(text).trim()) post({ type: "send", text: String(text).trim().slice(0, 4000) }); };
  const copy = (text) => post({ type: "copy", text: String(text) });
  const openUrl = (url) => post({ type: "open", url: String(url) });

  const nf = (o) => new Intl.NumberFormat("zh-CN", o);
  const num = (v, d = 0) => (Number.isFinite(+v) ? nf({ maximumFractionDigits: d }).format(+v) : "—");
  const fmt = Object.assign((v, d) => num(v, d), {
    num,
    money: (v, d = 0, cur = "¥") => (Number.isFinite(+v) ? cur + nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(+v) : "—"),
    pct: (v, d = 1) => (Number.isFinite(+v) ? nf({ maximumFractionDigits: d }).format(+v) + "%" : "—"),
    compact: (v, d = 1) => {
      const n = +v; if (!Number.isFinite(n)) return "—";
      const a = Math.abs(n);
      if (a >= 1e8) return num(n / 1e8, d) + " 亿";
      if (a >= 1e4) return num(n / 1e4, d) + " 万";
      return num(n, d);
    },
    date: (v, o) => new Date(v).toLocaleDateString("zh-CN", o),
  });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const range = (a, b, step = 1) => { if (b === undefined) { b = a; a = 0; } const out = []; for (let x = a; step > 0 ? x < b : x > b; x += step) { out.push(x); if (out.length > 10000) break; } return out; };
  const sum = (xs) => xs.reduce((s, x) => s + (+x || 0), 0);
  const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };

  // Serializes a rendered tree: functions become ids, user components are expanded.
  let fnSeq = 0;
  function ser(v, depth) {
    if (depth > 60) throw new Error("界面嵌套太深");
    if (v === null || v === undefined || v === false || v === true) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    if (typeof v === "bigint") return String(v);
    if (typeof v === "function") { const id = ++fnSeq; fns.set(id, v); return { $fn: id }; }
    if (Array.isArray(v)) return v.map((x) => ser(x, depth + 1));
    if (v && v.$el) {
      if (typeof v.t === "function") {
        const props = Object.assign({}, v.p, { children: v.c.length === 1 ? v.c[0] : v.c });
        return ser(v.t(props), depth + 1);
      }
      const p = {};
      for (const k in v.p) if (k !== "children") p[k] = serProp(v.p[k], depth + 1);
      const c = [];
      const flat = (xs) => { for (const x of xs) Array.isArray(x) ? flat(x) : c.push(x); };
      flat(v.c);
      return { t: String(v.t), p, c: c.map((x) => ser(x, depth + 1)).filter((x) => x !== null && x !== "") };
    }
    if (v instanceof Date) return v.toLocaleString("zh-CN");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  function serProp(v, depth) {
    if (typeof v === "function") { const id = ++fnSeq; fns.set(id, v); return { $fn: id }; }
    if (v && v.$el) return { $node: ser(v, depth) };
    if (Array.isArray(v)) return v.map((x) => serProp(x, depth + 1));
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = serProp(v[k], depth + 1); return o; }
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return v;
  }

  function render() {
    pending = false;
    if (!program || rendering) return;
    rendering = true;
    hook = 0; effects = [];
    prevFns = fns; fns = new Map(); fnSeq = 0;
    try {
      const tree = ser(program(), 0);
      post({ type: "tree", tree });
      let s; try { s = JSON.stringify(slots); } catch { s = lastSlots; }
      if (s !== lastSlots) { lastSlots = s; post({ type: "state", slots: JSON.parse(s) }); }
    } catch (e) {
      post({ type: "error", phase: "render", message: (e && e.message) || String(e) });
    } finally {
      rendering = false;
    }
    for (const run of effects.splice(0)) try { run(); } catch (e) { post({ type: "error", phase: "effect", message: (e && e.message) || String(e) }); }
  }
  function schedule() {
    if (pending) return;
    pending = true;
    if (rendering) return;
    setTimeout(render, 16);
  }

  const api = { h, Fragment, useState, useMemo, useCallback, useRef, useEffect, useInterval, send, copy, openUrl, fmt, clamp, range, sum, round };
  const names = Object.keys(scope).concat(Object.keys(api));
  const values = names.map((n) => (n in api ? api[n] : scope[n]));

  addEventListener("error", (e) => { post({ type: "error", phase: "async", message: e.message || "未知错误" }); e.preventDefault && e.preventDefault(); });
  addEventListener("unhandledrejection", (e) => post({ type: "error", phase: "async", message: (e.reason && e.reason.message) || String(e.reason) }));

  listen((m) => {
    if (m.type === "load") {
      if (Array.isArray(m.slots) && !program) { slots = m.slots; try { lastSlots = JSON.stringify(slots); } catch {} }
      try {
        const make = new Function(...names, m.code + "\nreturn __App;");
        program = make(...values);
      } catch (e) {
        post({ type: "error", phase: "load", message: (e && e.message) || String(e) });
        post({ type: "idle" });
        return;
      }
      render();
      post({ type: "idle" });
    } else if (m.type === "call") {
      const fn = fns.get(m.id) || prevFns.get(m.id);
      if (fn) {
        try { fn(...(Array.isArray(m.args) ? m.args : [])); }
        catch (e) { post({ type: "error", phase: "event", message: (e && e.message) || String(e) }); }
      }
      if (pending) render();
      post({ type: "idle" });
    }
  });
}
`.replace("__COMPONENTS__", JSON.stringify(COMPONENTS));

/** The sandboxed frame: starts the worker (or runs the runtime itself) and relays messages. */
export function frameSrcdoc(): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; form-action 'none'; base-uri 'none'";
  const workerCode = `${RUNTIME}\n__genui((m) => postMessage(m), (fn) => addEventListener("message", (e) => fn(e.data)));`;
  const frameCode = `
(() => {
  const B = ${JSON.stringify(BRIDGE)};
  const up = (m) => parent.postMessage(Object.assign({ [B]: 1 }, m), "*");
  let toRuntime;
  try {
    const url = URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = (e) => up(e.data);
    w.onerror = (e) => { up({ type: "error", phase: "async", message: e.message || "运行出错" }); e.preventDefault(); };
    toRuntime = (m) => w.postMessage(m);
  } catch (err) {
    // No workers here (some browsers in sandboxed frames): run in the frame instead.
    const handlers = [];
    ${RUNTIME}
    __genui((m) => up(m), (fn) => handlers.push(fn));
    toRuntime = (m) => setTimeout(() => handlers.forEach((h) => h(m)), 0);
  }
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || !e.data[B]) return;
    toRuntime(e.data);
  });
  up({ type: "ready" });
})();`;
  const safe = frameCode.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${safe}</script></body></html>`;
}
