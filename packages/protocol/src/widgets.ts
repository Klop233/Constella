// Interactive UI ("智能界面"): an agent reply may contain fenced blocks whose info string is `ui`,
// optionally followed by a title. There are three kinds of block:
//
//   ```ui 房贷计算器            a small component program (hooks and plain JS, then a JSX tree of the
//   const [rate, setRate] …    platform's components) that runs isolated in a worker; the web app
//   ```                        renders the resulting tree with its own components.
//
//   ```ui-json 房贷对比         the streaming UI DSL: one JSON op per line, read by the hub while the
//   {"op":"node","id":"root"…} reply is still being written and rendered incrementally. This is the
//   ```                        safe, preferred form — nothing in it is ever executed.
//
//   ```ui-html 小游戏           the escape hatch: a self-contained page in a sandboxed iframe, for what
//   <canvas id=c></canvas>     the components can't express.
//
// `ui-html` blocks (or ui blocks that are plainly HTML) are pages; anything else is a program.

export type IntelligentUiLevel = "off" | "balanced" | "rich";
export const INTELLIGENT_UI_LEVELS: readonly IntelligentUiLevel[] = ["off", "balanced", "rich"];

/** The info string of a streaming-DSL block. */
export const UI_JSON_LANG = "ui-json";

export type WidgetFormat = "components" | "html" | "json";
export type MessagePart = { kind: "md"; text: string } | { kind: "ui"; title: string; source: string; closed: boolean; format: WidgetFormat };

/** HTML pages use script/style tags, class="…" attributes or a doctype; component programs never do. */
export function widgetFormat(lang: string, source: string): WidgetFormat {
  if (lang === UI_JSON_LANG) return "json";
  if (lang === "ui-html") return "html";
  return /<(script|style)\b|\bclass="|<!doctype|<html\b/i.test(source) ? "html" : "components";
}

// A fence opens with 3+ backticks or tildes at line start (up to 3 spaces of indent) and closes
// with the same character, at least as long, on a line of its own (CommonMark).
const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/** Splits a reply into markdown and ui parts. A ui block still being streamed has `closed: false`. */
export function splitWidgets(text: string): MessagePart[] {
  if (!/(`{3,}|~{3,})[ \t]*ui(\b|-html\b|-json\b)/i.test(text)) return [{ kind: "md", text }];
  const lines = text.split("\n");
  const parts: MessagePart[] = [];
  let md: string[] = [];
  let fence: string | null = null; // an open non-ui fence; ui markers inside it are just code
  const flushMd = () => {
    const t = md.join("\n");
    if (t.trim()) parts.push({ kind: "md", text: t });
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fence) {
      md.push(line);
      if (closes(line, fence)) fence = null;
      continue;
    }
    const m = OPEN.exec(line);
    if (!m) {
      md.push(line);
      continue;
    }
    const marker = m[1] ?? "```";
    const info = (m[2] ?? "").trim();
    const ui = /^(ui(?:-html|-json)?)(?:\s+(.*))?$/i.exec(info);
    if (!ui) {
      fence = marker;
      md.push(line);
      continue;
    }
    flushMd();
    const body: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (closes(l, marker)) {
        closed = true;
        break;
      }
      body.push(l);
    }
    const source = body.join("\n");
    parts.push({ kind: "ui", title: (ui[2] ?? "").trim().slice(0, 80), source, closed, format: widgetFormat((ui[1] ?? "ui").toLowerCase(), source) });
  }
  flushMd();
  return parts.length ? parts : [{ kind: "md", text }];
}

function closes(line: string, marker: string): boolean {
  const t = line.trim();
  return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t) && !line.startsWith("    ");
}

/**
 * The streaming-DSL blocks of a reply, in order, with the position they take among all ui blocks
 * (which is how the hub and the browser agree on a block's identity while the text grows).
 */
export function uiJsonBlocks(text: string): { index: number; title: string; source: string; closed: boolean }[] {
  const parts = splitWidgets(text);
  const out: { index: number; title: string; source: string; closed: boolean }[] = [];
  let index = 0;
  for (const p of parts) {
    if (p.kind !== "ui") continue;
    if (p.format === "json") out.push({ index, title: p.title, source: p.source, closed: p.closed });
    index++;
  }
  return out;
}

/** The reply with each ui block replaced by a short placeholder, for prompts that only need the prose. */
export function stripWidgets(text: string): string {
  const parts = splitWidgets(text);
  if (parts.length === 1 && parts[0]?.kind === "md") return text;
  return parts.map((p) => (p.kind === "md" ? p.text : `［交互界面${p.title ? `：${p.title}` : ""}］`)).join("\n\n");
}
