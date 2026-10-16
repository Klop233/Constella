import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * Simple in-place editing of Word / Excel / PowerPoint files: read the text, change text, write it back into the
 * package XML. Everything else in the file (styles, formulas, images, layout) is left byte-for-byte as it was.
 */

export type OfficeKind = "docx" | "xlsx" | "pptx";
export const MAX_OFFICE_ROWS = 500;
export const MAX_OFFICE_COLS = 60;

export interface OfficeSheet {
  name: string;
  /** Rows of display values; null marks a cell that holds a formula (read-only). */
  rows: ({ v: string; f?: boolean } | null)[][];
  /** Row / column numbers (1-based) of rows[0][0]; always 1,1. Kept so edits can address cells by position. */
  truncated: boolean;
}
export interface OfficeDoc {
  kind: OfficeKind;
  /** docx: one group of paragraphs. pptx: one group per slide. */
  groups: { title: string; paragraphs: string[] }[];
  sheets: OfficeSheet[];
}
export type OfficeEdit =
  | { type: "text"; group: number; index: number; text: string }
  | { type: "cell"; sheet: number; row: number; col: number; value: string };

export function officeKind(filename: string): OfficeKind | null {
  const m = /\.(docx|xlsx|pptx)$/i.exec(filename);
  return m ? (m[1]!.toLowerCase() as OfficeKind) : null;
}

const MAX_XML = 30 * 1024 * 1024;

function open(buf: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(buf, { filter: (f) => f.name.endsWith(".xml") || f.name.endsWith(".rels") ? f.originalSize <= MAX_XML : true });
  } catch {
    throw new Error("这个文件已损坏，或不是有效的 Office 文件");
  }
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Matches of paragraphs: <w:p ...>…</w:p> / <a:p>…</a:p> (not <w:pPr>, <w:pict> …). */
function paragraphRe(ns: "w" | "a"): RegExp {
  return new RegExp(`<${ns}:p(?:\\s[^>]*?)?(?:/>|>[\\s\\S]*?</${ns}:p>)`, "g");
}
function textRe(ns: "w" | "a"): RegExp {
  return new RegExp(`(<${ns}:t(?:\\s[^>]*)?>)([\\s\\S]*?)(</${ns}:t>)`, "g");
}

function paragraphText(p: string, ns: "w" | "a"): string {
  let out = "";
  // Text runs and tabs / breaks in document order.
  const re = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>|<${ns}:tab\\s*/>|<${ns}:br\\s*/>`, "g");
  for (const m of p.matchAll(re)) out += m[1] !== undefined ? unescapeXml(m[1]) : m[0].includes(":tab") ? "\t" : "\n";
  return out;
}

/** Put `text` into the first text run of the paragraph and empty the rest; keeps the paragraph's formatting. */
function setParagraphText(p: string, ns: "w" | "a", text: string): string {
  const esc = escapeXml(text.replace(/\r?\n/g, " "));
  let first = true;
  const res = p.replace(textRe(ns), (_, open: string, _body: string, close: string) => {
    if (!first) return `${open}${close}`;
    first = false;
    const o = ns === "w" && !/xml:space/.test(open) ? open.replace(/>$/, ' xml:space="preserve">') : open;
    return `${o}${esc}${close}`;
  });
  if (!first) return res;
  // No text run yet (an empty paragraph): add one before the end of the paragraph.
  const run = ns === "w" ? `<w:r><w:t xml:space="preserve">${esc}</w:t></w:r>` : `<a:r><a:t>${esc}</a:t></a:r>`;
  if (/\/>$/.test(p)) return p.replace(/\s*\/>$/, `>${run}</${ns}:p>`);
  if (ns === "a") {
    // DrawingML needs runs before a:endParaRPr.
    if (/<a:endParaRPr/.test(p)) return p.replace(/<a:endParaRPr/, `${run}<a:endParaRPr`);
  }
  return p.replace(new RegExp(`</${ns}:p>$`), `${run}</${ns}:p>`);
}

function slideNames(files: Record<string, Uint8Array>): string[] {
  return Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
}

function colName(n: number): string {
  let s = "";
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}
function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const f = files["xl/sharedStrings.xml"];
  if (!f) return [];
  return [...strFromU8(f).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]!)).join(""));
}

/** Sheet names with the package path of each sheet's XML, in workbook order. */
function sheetFiles(files: Record<string, Uint8Array>): { name: string; path: string }[] {
  const wb = files["xl/workbook.xml"];
  const rels = files["xl/_rels/workbook.xml.rels"];
  if (!wb || !rels) return [];
  const target = new Map<string, string>();
  for (const m of strFromU8(rels).matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /\sId="([^"]+)"/.exec(m[0])?.[1];
    const t = /\sTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  }
  const out: { name: string; path: string }[] = [];
  for (const m of strFromU8(wb).matchAll(/<sheet\s[^>]*>/g)) {
    const name = /\sname="([^"]*)"/.exec(m[0])?.[1];
    const rid = /\sr:id="([^"]+)"/.exec(m[0])?.[1];
    const path = rid ? target.get(rid) : undefined;
    if (name !== undefined && path && files[path]) out.push({ name: unescapeXml(name), path });
  }
  return out;
}

export function readOffice(kind: OfficeKind, buf: Uint8Array): OfficeDoc {
  const files = open(buf);
  if (kind === "docx") {
    const xml = files["word/document.xml"];
    if (!xml) throw new Error("找不到文档正文");
    const paragraphs = [...strFromU8(xml).matchAll(paragraphRe("w"))].map((m) => paragraphText(m[0], "w"));
    return { kind, groups: [{ title: "正文", paragraphs }], sheets: [] };
  }
  if (kind === "pptx") {
    const groups = slideNames(files).map((n, i) => ({
      title: `第 ${i + 1} 页`,
      paragraphs: [...strFromU8(files[n]!).matchAll(paragraphRe("a"))].map((m) => paragraphText(m[0], "a")),
    }));
    return { kind, groups, sheets: [] };
  }
  const strings = sharedStrings(files);
  const sheets: OfficeSheet[] = sheetFiles(files).map(({ name, path }) => {
    const xml = strFromU8(files[path]!);
    const rows: OfficeSheet["rows"] = [];
    let truncated = false;
    for (const rm of xml.matchAll(/<row\s[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
      const rowNo = Number(/\sr="(\d+)"/.exec(rm[0])?.[1] ?? rows.length + 1);
      if (rowNo > MAX_OFFICE_ROWS) {
        truncated = true;
        break;
      }
      const row = (rows[rowNo - 1] ??= []);
      for (const cm of rm[0].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]!;
        const ref = /\sr="([A-Z]+)\d+"|^r="([A-Z]+)\d+"/.exec(attrs);
        const col = colNumber((ref?.[1] ?? ref?.[2]) || "");
        if (!col) continue;
        if (col > MAX_OFFICE_COLS) {
          truncated = true;
          continue;
        }
        const body = cm[2] ?? "";
        const t = /(?:^|\s)t="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let text = "";
        if (t === "s") text = strings[Number(v)] ?? "";
        else if (t === "inlineStr") text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]!)).join("");
        else if (v !== undefined) text = unescapeXml(v);
        if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
        row[col - 1] = { v: text, ...(/<f[\s>/]/.test(body) ? { f: true } : {}) };
      }
    }
    // Dense rows for JSON: holes become null.
    const dense = Array.from({ length: rows.length }, (_, i) => {
      const r = rows[i] ?? [];
      return Array.from({ length: r.length }, (_, j) => r[j] ?? null);
    });
    return { name, rows: dense, truncated };
  });
  return { kind, groups: [], sheets };
}

function editCell(xml: string, row: number, col: number, value: string): string {
  const ref = `${colName(col)}${row}`;
  const trimmed = value.trim();
  const numeric = trimmed !== "" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed);
  const build = (attrs: string) => {
    // Keep style (s="…") of the cell; drop t / r which are rebuilt.
    const style = /(?:^|\s)s="([^"]+)"/.exec(attrs)?.[1];
    const s = style ? ` s="${style}"` : "";
    if (value === "") return `<c r="${ref}"${s}/>`;
    if (numeric) return `<c r="${ref}"${s}><v>${trimmed}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  };
  const cellRe = new RegExp(`<c\\s((?:[^>]*?\\s)?r="${ref}"[^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const hit = cellRe.exec(xml);
  if (hit) {
    if (/<f[\s>/]/.test(hit[0])) throw new Error(`${ref} 是公式单元格，不能直接改`);
    return xml.slice(0, hit.index) + build(hit[1]!) + xml.slice(hit.index + hit[0].length);
  }
  const rowRe = new RegExp(`<row\\s((?:[^>]*?\\s)?r="${row}"[^>]*?)(/>|>([\\s\\S]*?)</row>)`);
  const rm = rowRe.exec(xml);
  if (rm) {
    const attrs = rm[1]!.replace(/\sspans="[^"]*"/, "");
    const cells = rm[3] ?? "";
    // Insert in column order.
    let at = cells.length;
    for (const cm of cells.matchAll(/<c\s[^>]*?r="([A-Z]+)\d+"/g)) {
      if (colNumber(cm[1]!) > col) {
        at = cm.index;
        break;
      }
    }
    return xml.slice(0, rm.index) + `<row ${attrs}>${cells.slice(0, at)}${build("")}${cells.slice(at)}</row>` + xml.slice(rm.index + rm[0].length);
  }
  // A new row, placed in row order inside <sheetData>.
  const newRow = `<row r="${row}">${build("")}</row>`;
  if (/<sheetData\s*\/>/.test(xml)) return xml.replace(/<sheetData\s*\/>/, `<sheetData>${newRow}</sheetData>`);
  for (const m of xml.matchAll(/<row\s[^>]*?r="(\d+)"/g)) {
    if (Number(m[1]) > row) return xml.slice(0, m.index) + newRow + xml.slice(m.index);
  }
  return xml.replace(/<\/sheetData>/, `${newRow}</sheetData>`);
}

/** Applies edits and returns the new file's bytes. Throws a user-readable Error. */
export function editOffice(kind: OfficeKind, buf: Uint8Array, edits: OfficeEdit[]): Uint8Array {
  const files = open(buf);
  const xmlOf = new Map<string, string>();
  const get = (p: string) => {
    let s = xmlOf.get(p);
    if (s === undefined) {
      const f = files[p];
      if (!f) throw new Error("文件结构不完整");
      s = strFromU8(f);
      xmlOf.set(p, s);
    }
    return s;
  };
  // Paragraph edits go in descending index order per part so earlier matches stay valid.
  const textEdits = new Map<string, { index: number; text: string }[]>();
  const sheets = kind === "xlsx" ? sheetFiles(files) : [];
  for (const e of edits) {
    if (e.type === "text") {
      if (kind === "xlsx") throw new Error("表格要按单元格修改");
      const part = kind === "docx" ? "word/document.xml" : slideNames(files)[e.group];
      if (!part) throw new Error("找不到要修改的页");
      (textEdits.get(part) ?? textEdits.set(part, []).get(part)!).push({ index: e.index, text: e.text });
    } else {
      if (kind !== "xlsx") throw new Error("只有表格可以按单元格修改");
      const sheet = sheets[e.sheet];
      if (!sheet) throw new Error("找不到要修改的工作表");
      if (e.row < 1 || e.row > 100000 || e.col < 1 || e.col > 16384) throw new Error("单元格位置不对");
      xmlOf.set(sheet.path, editCell(get(sheet.path), e.row, e.col, e.value));
    }
  }
  const ns = kind === "docx" ? "w" : "a";
  for (const [part, list] of textEdits) {
    let xml = get(part);
    const ps = [...xml.matchAll(paragraphRe(ns))];
    for (const { index, text } of list.sort((a, b) => b.index - a.index)) {
      const m = ps[index];
      if (!m) throw new Error("找不到要修改的段落，文件可能已经变了，刷新后再试");
      if (paragraphText(m[0], ns) === text) continue;
      xml = xml.slice(0, m.index) + setParagraphText(m[0], ns, text) + xml.slice(m.index + m[0].length);
    }
    xmlOf.set(part, xml);
  }
  if (kind === "xlsx" && xmlOf.size) {
    // Cached formula results are stale after a value change; ask Excel to recalculate on open.
    const wb = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : null;
    if (wb) {
      xmlOf.set(
        "xl/workbook.xml",
        /<calcPr[^>]*\/>/.test(wb) ? wb.replace(/<calcPr([^>]*?)\/>/, (m, a: string) => (/fullCalcOnLoad/.test(a) ? m : `<calcPr${a} fullCalcOnLoad="1"/>`)) : wb.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>'),
      );
    }
  }
  for (const [p, s] of xmlOf) files[p] = strToU8(s);
  return zipSync(files, { level: 6 });
}
