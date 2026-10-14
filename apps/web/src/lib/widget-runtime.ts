// The page an interactive reply block (智能界面) runs in: a sandboxed iframe (scripts only, opaque origin)
// whose srcdoc carries a CSP, the site's theme variables, a small style kit, the `ui` bridge and the
// agent's HTML. The class names and `ui` API must match what agents are told in apps/hub/src/widgets.ts.
import chartUrl from "../../node_modules/chart.js/dist/chart.umd.min.js?url";

/** Marks our messages so stray postMessages from the agent's code can't pass as bridge calls. */
export const BRIDGE = "constella-widget";

/** Theme variables copied into the frame (CSS variables don't cross iframe boundaries). */
const THEME_VARS: [string, string][] = [
  ["--bg", "--bg"],
  ["--surface", "--surface"],
  ["--surface-2", "--surface-2"],
  ["--border", "--border"],
  ["--text", "--text"],
  ["--muted", "--muted"],
  ["--accent", "--color-accent"],
  ["--accent-2", "--accent-2"],
  ["--accent-soft", "--color-accent-soft"],
  ["--ok", "--ok"],
  ["--warn", "--warn"],
  ["--danger", "--danger"],
  ["--series-1", "--series-1"],
  ["--series-2", "--series-2"],
  ["--series-3", "--series-3"],
  ["--series-4", "--series-4"],
  ["--series-5", "--series-5"],
  ["--series-6", "--series-6"],
  ["--font-sans", "--font-sans"],
  ["--font-display", "--font-display"],
  ["--font-mono", "--font-mono"],
];

export interface WidgetTheme {
  mode: "light" | "dark";
  css: string;
}

/** The current resolved theme, as a `:root{…}` block for the frame. */
export function themeSnapshot(): WidgetTheme {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const mode = root.dataset.mode === "dark" ? "dark" : "light";
  const vars = THEME_VARS.map(([to, from]) => `${to}:${cs.getPropertyValue(from).trim()};`).join("");
  return { mode, css: `:root{${vars}color-scheme:${mode};}` };
}

const KIT_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:12px 14px 14px;background:transparent;color:var(--text);font:14px/1.6 var(--font-display),var(--font-sans),system-ui,sans-serif;word-break:break-word;overflow-x:hidden}
body.fill{padding:16px 20px}
h1,h2,h3,h4{font-weight:600;line-height:1.35;margin:.4em 0 .3em}
h1{font-size:18px}h2{font-size:16px}h3,h4{font-size:14px}
p{margin:.35em 0}
a{color:var(--accent)}
img,svg,video,canvas{max-width:100%}
svg{color:var(--text)}
hr{border:0;border-top:1px solid var(--border);margin:12px 0}
code,pre,kbd{font-family:var(--font-mono);font-size:.88em}
code{background:var(--surface-2);padding:.1em .35em;border-radius:3px}
pre{background:var(--surface-2);border:1px solid var(--border);padding:.6em .8em;border-radius:6px;overflow-x:auto}
.muted{color:var(--muted)}.small{font-size:12.5px}.big{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.title{font-weight:600;font-size:15px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.danger{color:var(--danger)}.accent{color:var(--accent)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.col{display:flex;flex-direction:column;gap:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.spacer{flex:1}
.card{border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--surface)}
.stat{display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--surface)}
.stat .label{font-size:12px;color:var(--muted)}
.stat .value{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3}
.stat .sub{font-size:12px;color:var(--muted)}
.badge{display:inline-flex;align-items:center;border-radius:3px;padding:0 6px;font-size:11.5px;line-height:18px;background:var(--surface-2);color:var(--muted)}
.badge.ok{background:color-mix(in oklab,var(--ok) 14%,transparent);color:var(--ok)}
.badge.warn{background:color-mix(in oklab,var(--warn) 14%,transparent);color:var(--warn)}
.badge.danger{background:color-mix(in oklab,var(--danger) 14%,transparent);color:var(--danger)}
.badge.accent{background:var(--accent-soft);color:var(--accent)}
button,.chip,.tabs>button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
button{height:32px;padding:0 12px;border-radius:4px;border:1px solid var(--border);background:var(--surface);font-size:13.5px;transition:border-color .15s,background .15s}
button:hover{border-color:color-mix(in oklab,var(--text) 25%,transparent)}
button:active{background:var(--surface-2)}
button.primary{background:var(--accent);border-color:transparent;color:#fff;font-weight:500}
button.primary:hover{filter:brightness(1.06)}
button.ghost{border-color:transparent;background:transparent}
button.ghost:hover{background:color-mix(in oklab,var(--text) 6%,transparent)}
button:disabled{opacity:.5;cursor:default}
button.small{height:26px;padding:0 9px;font-size:12.5px}
.chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);font-size:12.5px}
.chip.active{border-color:color-mix(in oklab,var(--accent) 55%,transparent);background:var(--accent-soft);color:var(--accent)}
.tabs{display:flex;gap:2px;padding:2px;border-radius:6px;background:var(--surface-2);width:max-content;max-width:100%;overflow-x:auto}
.tabs>button{height:26px;padding:0 10px;border:1px solid transparent;background:transparent;border-radius:4px;font-size:12.5px;color:var(--muted)}
.tabs>button.active{background:var(--surface);border-color:var(--border);color:var(--text)}
.bar{height:6px;border-radius:999px;background:color-mix(in oklab,var(--text) 12%,transparent);overflow:hidden}
.bar::after{content:"";display:block;height:100%;width:var(--v,0%);background:var(--bar-color,var(--accent));border-radius:inherit;transition:width .25s}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
label b,label strong{color:var(--text);font-weight:600}
label:has(>input[type=checkbox]),label:has(>input[type=radio]){flex-direction:row;align-items:center;gap:6px;color:var(--text);cursor:pointer}
input,select,textarea{font:inherit;font-size:13.5px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:6px;outline:none}
input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=color]),select{height:32px;padding:0 10px}
textarea{padding:8px 10px;resize:vertical;min-height:64px}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
input[type=range]{width:100%;accent-color:var(--accent);background:transparent;border:0;height:20px}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:15px;height:15px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
th{font-weight:500;color:var(--muted);font-size:12.5px}
.table-wrap{overflow-x:auto}
details{border:1px solid var(--border);border-radius:8px;padding:8px 12px}
summary{cursor:pointer;font-weight:500}
.chart{position:relative;height:240px;width:100%}
.chart.tall{height:320px}.chart.short{height:180px}
`;

/** Runs before the agent's code: the `ui` bridge, theme updates, chart defaults, and error reporting. */
const RUNTIME_JS = `
(() => {
  const B = ${JSON.stringify(BRIDGE)};
  const boot = JSON.parse(document.getElementById("cw-boot").textContent);
  const post = (type, data) => parent.postMessage({ [B]: 1, type, ...data }, "*");
  let state = boot.state && typeof boot.state === "object" ? boot.state : {};
  const themeCbs = [];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ui = {
    get state() { return state; },
    setState(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      post("state", { data: state });
    },
    send(text) { if (typeof text === "string" && text.trim()) post("send", { text: text.trim().slice(0, 4000) }); },
    copy(text) { post("copy", { text: String(text) }); },
    open(url) { post("open", { url: String(url) }); },
    color(i) { return css("--series-" + ((((i | 0) % 6) + 6) % 6 + 1)); },
    css,
    onTheme(cb) { if (typeof cb === "function") themeCbs.push(cb); },
    get theme() { return document.documentElement.dataset.mode; },
  };
  Object.defineProperty(window, "ui", { value: Object.freeze(ui) });
  if (boot.fill) document.addEventListener("DOMContentLoaded", () => document.body.classList.add("fill"));

  // Errors in the agent's code are shown under the block, with a way to ask for a fix.
  const report = (message) => post("error", { message: String(message).slice(0, 500) });
  addEventListener("error", (e) => {
    if (e.message && /ResizeObserver loop/.test(e.message)) return;
    report(e.message || "资源加载失败");
  }, true);
  addEventListener("unhandledrejection", (e) => report(e.reason && e.reason.message ? e.reason.message : e.reason));

  // Links open in a new tab through the host; forms never navigate the frame.
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    e.preventDefault();
    ui.open(a.href);
  });
  document.addEventListener("submit", (e) => e.preventDefault());

  // Height follows the content so the block never scrolls on its own (except in full screen).
  let last = 0;
  const measure = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h !== last) { last = h; post("height", { height: h }); }
  };
  new ResizeObserver(measure).observe(document.documentElement);

  // Chart.js: site fonts and colors, and series colors for datasets that don't set their own.
  const series = () => [1, 2, 3, 4, 5, 6].map((i) => css("--series-" + i));
  // Canvas can't take color-mix(); resolve the color to #rrggbb first.
  const probe = document.createElement("canvas").getContext("2d");
  const alpha = (c, a) => {
    probe.fillStyle = "#000";
    probe.fillStyle = c;
    const hex = String(probe.fillStyle);
    if (a >= 1 || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  };
  const ROUND = new Set(["pie", "doughnut", "polarArea"]);
  function paint(chart) {
    const s = series();
    const type = chart.config.type;
    chart.data.datasets.forEach((ds, i) => {
      const own = ds.__cw || (ds.__cw = { bg: ds.backgroundColor === undefined, border: ds.borderColor === undefined });
      const t = ds.type || type;
      const c = s[i % 6];
      if (ROUND.has(t)) {
        const n = (ds.data || []).length;
        if (own.bg) ds.backgroundColor = Array.from({ length: n }, (_, j) => s[j % 6]);
        if (own.border) ds.borderColor = css("--surface");
      } else {
        if (own.border) ds.borderColor = c;
        if (own.bg) ds.backgroundColor = t === "line" || t === "radar" ? alpha(c, ds.fill ? 0.18 : 1) : t === "bubble" || t === "scatter" ? alpha(c, 0.7) : c;
      }
    });
  }
  function chartDefaults() {
    const C = window.Chart;
    if (!C) return;
    C.defaults.color = css("--muted");
    C.defaults.borderColor = alpha(css("--text"), 0.1);
    C.defaults.font.family = css("--font-display") || css("--font-sans") || "system-ui, sans-serif";
    C.defaults.font.size = 12;
    C.defaults.maintainAspectRatio = false;
    C.defaults.plugins.legend.labels.boxWidth = 10;
    C.defaults.plugins.legend.labels.boxHeight = 10;
    C.defaults.plugins.tooltip.backgroundColor = css("--text");
    C.defaults.plugins.tooltip.titleColor = css("--surface");
    C.defaults.plugins.tooltip.bodyColor = css("--surface");
    C.defaults.elements.line.borderWidth = 2;
    C.defaults.elements.line.tension = 0.25;
    C.defaults.elements.point.radius = 2.5;
    C.defaults.elements.bar.borderRadius = 3;
  }
  if (window.Chart) {
    chartDefaults();
    window.Chart.register({ id: "cwColors", beforeUpdate: paint });
  }

  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== parent || !m || !m[B]) return;
    if (m.type === "theme") {
      document.getElementById("cw-theme").textContent = m.css;
      document.documentElement.dataset.mode = m.mode;
      chartDefaults();
      // Resolved options are cached per chart; drop them so the new defaults apply.
      if (window.Chart) for (const c of Object.values(window.Chart.instances)) { c.config.clearCache && c.config.clearCache(); c.update("none"); }
      for (const cb of themeCbs) try { cb(m.mode); } catch (err) { report(err && err.message); }
    }
  });
  addEventListener("load", () => { measure(); post("ready", {}); });
})();
`;

export interface SrcdocInput {
  source: string;
  theme: WidgetTheme;
  state: Record<string, unknown>;
  /** Full-screen: more padding, no height reports needed. */
  fill?: boolean;
  /** For saving as a standalone page: Chart.js inline instead of loaded from the hub. */
  chartInline?: string;
}

/** Chart.js is only loaded when the block uses it. */
export const usesChart = (source: string) => /\bChart\b/.test(source);

export function chartScriptUrl(): string {
  return new URL(chartUrl, location.href).href;
}

/** Keeps embedded JSON or code from closing the surrounding <script>. */
const scriptSafe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

export function buildSrcdoc({ source, theme, state, fill, chartInline }: SrcdocInput): string {
  const origin = location.origin;
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const chart = usesChart(source)
    ? chartInline
      ? `<script>${scriptSafe(chartInline)}</script>`
      : `<script src="${chartScriptUrl()}"></script>`
    : "";
  const boot = JSON.stringify({ state, fill: !!fill }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN" data-mode="${theme.mode}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style id="cw-theme">${theme.css}</style><style>${KIT_CSS}</style>
<script type="application/json" id="cw-boot">${boot}</script>
${chart}<script>${RUNTIME_JS}</script>
</head><body>
${source}
</body></html>`;
}
