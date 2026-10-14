import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Pictographs plus their joiners/modifiers; ©, ® and ™ are Extended_Pictographic too but read as text.
const EMOJI = /(?:(?![©®™])\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}])+\s*/gu;

/** Drop emoji from the text of <h1>–<h6> (the "标题不用表情" setting). */
function plainHeadings(html: string): string {
  return html.replace(/(<h[1-6][^>]*>)([\s\S]*?)(<\/h[1-6]>)/g, (_, open: string, body: string, close: string) =>
    open + body.replace(/(^|>)([^<]*)/g, (_m, gt: string, t: string) => gt + t.replace(EMOJI, "")).trim() + close,
  );
}

export const Markdown = memo(function Markdown({ text, className, noHeadingEmoji }: { text: string; className?: string; noHeadingEmoji?: boolean }) {
  const html = useMemo(() => {
    const clean = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    return noHeadingEmoji ? plainHeadings(clean) : clean;
  }, [text, noHeadingEmoji]);
  return <div className={`prose-chat ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
