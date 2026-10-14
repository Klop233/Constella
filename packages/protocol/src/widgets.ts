// Interactive UI ("智能界面"): an agent reply may contain fenced blocks whose info string is `ui`,
// optionally followed by a title, holding a self-contained HTML fragment that the web app renders
// inline in a sandboxed iframe:
//
//   ```ui 房贷计算器
//   <div class="card">…</div>
//   ```

export type IntelligentUiLevel = "off" | "balanced" | "rich";
export const INTELLIGENT_UI_LEVELS: readonly IntelligentUiLevel[] = ["off", "balanced", "rich"];

export type MessagePart = { kind: "md"; text: string } | { kind: "ui"; title: string; source: string; closed: boolean };

// A fence opens with 3+ backticks or tildes at line start (up to 3 spaces of indent) and closes
// with the same character, at least as long, on a line of its own (CommonMark).
const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/** Splits a reply into markdown and ui parts. A ui block still being streamed has `closed: false`. */
export function splitWidgets(text: string): MessagePart[] {
  if (!/(`{3,}|~{3,})[ \t]*ui\b/i.test(text)) return [{ kind: "md", text }];
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
    const ui = /^ui(?:\s+(.*))?$/i.exec(info);
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
    parts.push({ kind: "ui", title: (ui[1] ?? "").trim().slice(0, 80), source: body.join("\n"), closed });
  }
  flushMd();
  return parts.length ? parts : [{ kind: "md", text }];
}

function closes(line: string, marker: string): boolean {
  const t = line.trim();
  return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t) && !line.startsWith("    ");
}

/** The reply with each ui block replaced by a short placeholder, for prompts that only need the prose. */
export function stripWidgets(text: string): string {
  const parts = splitWidgets(text);
  if (parts.length === 1 && parts[0]?.kind === "md") return text;
  return parts.map((p) => (p.kind === "md" ? p.text : `［交互界面${p.title ? `：${p.title}` : ""}］`)).join("\n\n");
}
