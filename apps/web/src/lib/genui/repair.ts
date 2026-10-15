// Streaming: while a component block is still being written, render what is there so far. The
// statements must be complete (the tree has started), then the tree is cut at the last point where
// nothing is half-written (not inside a tag, an attribute or a {…} expression) and the elements still
// open are closed. Partial text inside an element is kept, so prose grows as it streams in.

import { splitProgram } from "./compile";

/** A complete program for the part written so far, or null when nothing can be shown yet. */
export function repairPartial(source: string): string | null {
  let parts: { statements: string; tree: string };
  try {
    parts = splitProgram(source);
  } catch {
    return null;
  }
  if (!parts.tree) return null;
  const cut = cutTree(parts.tree);
  if (!cut) return null;
  return `${parts.statements}\n${cut}`;
}

interface Scan {
  /** Position up to which the tree is complete. */
  safe: number;
  /** Elements open at `safe`, innermost last ("" is a fragment). */
  open: string[];
}

export function cutTree(src: string): string | null {
  const scan = scanTree(src);
  if (scan.safe <= 0) return null;
  let out = src.slice(0, scan.safe);
  for (let i = scan.open.length - 1; i >= 0; i--) out += scan.open[i] ? `</${scan.open[i]}>` : "</>";
  return out;
}

function scanTree(src: string): Scan {
  const open: string[] = [];
  let i = 0;
  let safe = 0;
  let safeOpen: string[] = [];
  const mark = () => {
    safe = i;
    safeOpen = open.slice();
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "<") {
      if (src[i + 1] === "/") {
        const end = src.indexOf(">", i);
        if (end < 0) break;
        open.pop();
        i = end + 1;
        mark();
        continue;
      }
      const tag = scanOpenTag(src, i);
      if (!tag) break;
      i = tag.end;
      if (!tag.selfClosing) open.push(tag.name);
      mark();
      continue;
    }
    if (ch === "{") {
      const end = scanExpr(src, i);
      if (end < 0) break;
      i = end;
      mark();
      continue;
    }
    // Text: every character is a safe stop.
    i++;
    mark();
  }
  if (i >= src.length) mark();
  return { safe, open: safeOpen };
}

/** An opening tag starting at `<`: its name and where it ends, or null if it isn't finished. */
function scanOpenTag(src: string, start: number): { name: string; end: number; selfClosing: boolean } | null {
  let i = start + 1;
  const m = /^[A-Za-z][\w.]*/.exec(src.slice(i, i + 64));
  const name = m ? m[0] : "";
  i += name.length;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ">") return { name, end: i + 1, selfClosing: false };
    if (ch === "/" && src[i + 1] === ">") return { name, end: i + 2, selfClosing: true };
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === "{") {
      const end = scanExpr(src, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    i++;
  }
  return null;
}

/** A JS expression starting at `{`: the index after its matching `}`, or -1 if unfinished. */
function scanExpr(src: string, start: number): number {
  const stack: string[] = ["}"];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    const top = stack[stack.length - 1];
    if (top === "`") {
      if (ch === "\\") i += 2;
      else if (ch === "`") (stack.pop(), i++);
      else if (ch === "$" && src[i + 1] === "{") (stack.push("}"), (i += 2));
      else i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return -1;
      i = j + 1;
      continue;
    }
    if (ch === "`") (stack.push("`"), i++);
    else if (ch === "{") (stack.push("}"), i++);
    else if (ch === "(") (stack.push(")"), i++);
    else if (ch === "[") (stack.push("]"), i++);
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (ch === top) stack.pop();
      i++;
      if (!stack.length) return i;
    } else if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl + 1;
    } else i++;
  }
  return -1;
}
