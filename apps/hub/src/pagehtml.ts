/// <reference lib="dom" />
import type { Frame, Page } from "playwright-core";

/**
 * Page HTML for the model: a faster, more exact alternative to screenshots for reading what a
 * page says (text, tables, prices, link targets, form values). By default it is cleaned —
 * scripts, styles, hidden elements and presentational attributes go, links become absolute,
 * form fields show what is currently filled in (passwords masked) — and paged by characters.
 */
export interface HtmlOptions {
  /** CSS selector to read only part of the page (every match, in every visible frame). */
  selector?: string;
  /** Unprocessed outerHTML, including scripts (embedded JSON data, JSON-LD, …). */
  raw?: boolean;
  /** Keep elements that aren't displayed (collapsed menus, inactive tabs, …). */
  includeHidden?: boolean;
  offset?: number;
  limit?: number;
}

interface FrameHtml {
  html: string;
  matches: number;
  hidden: number;
}

/** Runs inside the page; must be self-contained (it is serialized into the browser). */
function extract(o: { selector: string | null; raw: boolean; includeHidden: boolean }): FrameHtml {
  const roots = o.selector ? [...document.querySelectorAll(o.selector)] : [document.body ?? document.documentElement];
  if (o.raw) {
    const html = o.selector ? roots.map((r) => r.outerHTML).join("\n") : document.documentElement.outerHTML;
    return { html, matches: roots.length, hidden: 0 };
  }

  const DROP = new Set(["script", "style", "noscript", "template", "link", "meta", "base", "source", "track", "param", "object", "embed"]);
  const KEEP = new Set([
    "id", "name", "href", "src", "action", "alt", "title", "type", "value", "placeholder", "role", "for", "method",
    "checked", "selected", "disabled", "readonly", "required", "multiple", "open", "label", "colspan", "rowspan",
    "datetime", "download", "contenteditable", "data-testid", "aria-label", "aria-expanded", "aria-selected",
    "aria-checked", "aria-current", "aria-disabled", "aria-pressed", "aria-valuenow", "aria-haspopup",
  ]);
  const URLS = new Set(["href", "src", "action"]);
  const WRAPPERS = new Set(["div", "span", "font", "slot"]);
  /** Meaningful even when empty (table layout, form controls, media); other bare empty elements go. */
  const KEEP_EMPTY = new Set(["td", "th", "tr", "col", "br", "hr", "img", "input", "textarea", "select", "option", "button", "iframe", "canvas", "video", "audio", "progress", "meter"]);
  const VISIBLE_ANYWAY = new Set(["option", "optgroup", "br", "wbr"]);
  let hidden = 0;
  const dropped = (e: Element) => DROP.has(e.localName) || (e instanceof HTMLInputElement && e.type === "hidden");
  const shown = (e: Element) =>
    o.includeHidden ||
    VISIBLE_ANYWAY.has(e.localName) ||
    e.checkVisibility({ visibilityProperty: true }) ||
    getComputedStyle(e).display === "contents";

  // Pass 1, original and clone side by side: drop what isn't displayed, copy live form state,
  // and flatten open shadow roots into their hosts.
  const prep = (orig: Element, copy: Element) => {
    const os = [orig, ...orig.querySelectorAll("*")];
    const cs = [copy, ...copy.querySelectorAll("*")];
    const gone = new Set<Element>();
    const inSvg = new Set<Element>();
    os.forEach((oe, i) => {
      const ce = cs[i]!;
      const parent = oe.parentElement;
      if (parent && gone.has(parent)) return void gone.add(oe);
      if (parent && inSvg.has(parent)) return void inSvg.add(oe);
      if (dropped(oe) || !shown(oe)) {
        if (!dropped(oe)) hidden++;
        gone.add(oe);
        return void ce.remove();
      }
      if (oe.localName === "svg") return void inSvg.add(oe);
      if (oe instanceof HTMLInputElement) {
        if (oe.type === "checkbox" || oe.type === "radio") ce.toggleAttribute("checked", oe.checked);
        else if (oe.type === "password") oe.value ? ce.setAttribute("value", "••••••") : ce.removeAttribute("value");
        else if (oe.type !== "file") oe.value ? ce.setAttribute("value", oe.value) : ce.removeAttribute("value");
      } else if (oe instanceof HTMLTextAreaElement) {
        ce.textContent = oe.value;
      } else if (oe instanceof HTMLOptionElement) {
        ce.toggleAttribute("selected", oe.selected);
      }
      if (oe.shadowRoot) {
        for (const child of oe.shadowRoot.children) {
          const cc = child.cloneNode(true) as Element;
          ce.append(cc);
          prep(child, cc);
        }
      }
    });
  };

  // Pass 2, clone only: strip noise and needless nesting.
  const clean = (el: Element, pre: boolean) => {
    for (const n of [...el.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (!pre) (n as Text).data = (n as Text).data.replace(/\s+/g, " ");
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) {
        n.remove();
        continue;
      }
      const e = n as Element;
      const tag = e.localName;
      if (DROP.has(tag) || (tag === "input" && e.getAttribute("type") === "hidden")) {
        e.remove();
        continue;
      }
      if (tag === "svg") {
        const label = e.getAttribute("aria-label") || e.querySelector("title")?.textContent?.trim();
        if (!label) {
          e.remove();
          continue;
        }
        e.replaceChildren();
        for (const a of [...e.attributes]) e.removeAttribute(a.name);
        e.setAttribute("aria-label", label);
        continue;
      }
      for (const a of [...e.attributes]) {
        if (!KEEP.has(a.name)) {
          e.removeAttribute(a.name);
          continue;
        }
        let v = a.value.trim();
        if (URLS.has(a.name)) {
          if (/^javascript:/i.test(v)) {
            e.removeAttribute(a.name);
            continue;
          }
          if (/^data:/i.test(v)) v = "data:…";
          else {
            try {
              v = new URL(v, document.baseURI).href;
            } catch {}
          }
          if (v.length > 500) v = `${v.slice(0, 500)}…`;
        } else if (v.length > 1000) v = `${v.slice(0, 1000)}…`;
        e.setAttribute(a.name, v);
      }
      clean(e, pre || tag === "pre" || tag === "textarea");
      if (e.attributes.length) continue;
      const kids = [...e.childNodes].filter((k) => k.nodeType !== Node.TEXT_NODE || (k as Text).data.trim());
      if (!kids.length) {
        if (!KEEP_EMPTY.has(tag)) e.remove();
        continue;
      }
      if (!WRAPPERS.has(tag)) continue;
      const siblings = [...el.childNodes].filter((k) => k.nodeType !== Node.TEXT_NODE || (k as Text).data.trim());
      // A wrapper around a single element, or the only content of its parent, adds nothing.
      if ((kids.length === 1 && kids[0]!.nodeType === Node.ELEMENT_NODE) || siblings.length === 1 || tag === "slot") e.replaceWith(...e.childNodes);
    }
  };

  const parts = roots.map((root) => {
    if (!shown(root)) {
      hidden++;
      return "";
    }
    const holder = document.createElement("div");
    const copy = root.cloneNode(true) as Element;
    holder.append(copy);
    prep(root, copy);
    clean(holder, false);
    return holder.innerHTML;
  });
  // Collapse leftover runs of spaces (outside preformatted text) and start block elements on new lines.
  const html = parts
    .join("\n")
    .split(/(<(?:pre|textarea)\b[\s\S]*?<\/(?:pre|textarea)>)/)
    .map((x, i) => (i % 2 ? x : x.replace(/ {2,}/g, " ")))
    .join("")
    .replace(/\s*(<(?:div|p|li|tr|h[1-6]|section|article|header|footer|nav|main|aside|ul|ol|table|thead|tbody|form|dl|dt|dd|blockquote|pre|figure|details|summary|fieldset|iframe|select|button)\b)/g, "\n$1")
    .trim();
  return { html, matches: roots.length, hidden };
}

async function inFrame(frame: Frame, opts: Parameters<typeof extract>[0]): Promise<FrameHtml> {
  return await Promise.race([
    frame.evaluate(extract, opts),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取网页 HTML 超时")), 15_000).unref()),
  ]);
}

/** Child frames large enough to be content rather than trackers or ad pixels. */
async function contentFrames(page: Page): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame() || f.isDetached() || f.url() === "about:blank") continue;
    const box = await f
      .frameElement()
      .then((el) => el.boundingBox())
      .catch(() => null);
    if (box && box.width >= 100 && box.height >= 50) out.push(f);
  }
  return out;
}

export const HTML_DEFAULT_LIMIT = 30_000;

/** The page's HTML as tool output: a short header (URL, title, size, how to read on) and the HTML. */
export async function readPageHtml(page: Page, o: HtmlOptions = {}): Promise<string> {
  const opts = { selector: o.selector?.trim() || null, raw: !!o.raw, includeHidden: !!o.includeHidden };
  const main = await inFrame(page.mainFrame(), opts);
  let html = main.html;
  let matches = main.matches;
  let hidden = main.hidden;
  for (const f of await contentFrames(page)) {
    const r = await inFrame(f, opts).catch(() => null);
    if (!r?.html || (opts.selector && !r.matches)) continue;
    html += `\n\n<!-- iframe ${f.url()} -->\n${r.html}`;
    matches += r.matches;
    hidden += r.hidden;
  }

  const offset = Math.max(0, o.offset ?? 0);
  const limit = Math.max(1, o.limit ?? HTML_DEFAULT_LIMIT);
  const chunk = html.slice(offset, offset + limit);
  const end = offset + chunk.length;
  const head = [`URL: ${page.url()}`, `标题: ${await page.title().catch(() => "")}`];
  if (opts.selector) head.push(`范围: ${opts.selector}（匹配 ${matches} 处）`);
  if (!html) head.push(opts.selector ? "没有匹配的元素" : "页面没有内容");
  else if (offset >= html.length) head.push(`共 ${html.length} 字符，offset 已超出末尾`);
  else if (offset > 0 || end < html.length)
    head.push(`共 ${html.length} 字符，本次 ${offset}–${end}${end < html.length ? `；继续读用 offset=${end}，或用 selector 只读需要的部分` : "（已到末尾）"}`);
  if (hidden) head.push(`已省略 ${hidden} 个未显示的元素（includeHidden=true 可包含）`);
  return `${head.join("\n")}\n\n${chunk}`;
}
