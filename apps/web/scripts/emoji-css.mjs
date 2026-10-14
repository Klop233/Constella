// Regenerates src/emoji.css after bumping the emoji font packages: node scripts/emoji-css.mjs
import { readFileSync, writeFileSync } from "node:fs";
const web = new URL("..", import.meta.url).pathname;
const EMOJI = "200d,203c,2049,20e3,2139,231a-231b,2328,23cf,23e9-23f3,23f8-23fa,24c2,2600-27bf,2934-2935,2b05-2b07,2b1b-2b1c,2b50,2b55,3030,303d,3297,3299,fe0f,1f000-1faff,e0020-e007f";
const parse = (s) => s.split(",").map((p) => p.trim().replace(/^U\+/i, "")).map((p) => { const [a, b] = p.split("-"); return [parseInt(a, 16), parseInt(b ?? a, 16)]; });
const allowed = parse(EMOJI);
const fmt = (rs) => rs.map(([a, b]) => (a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`)).join(", ");
const intersect = (rs) => { const out = []; for (const [a, b] of rs) for (const [c, d] of allowed) { const lo = Math.max(a, c), hi = Math.min(b, d); if (lo <= hi) out.push([lo, hi]); } return out; };
const src = readFileSync(`${web}/node_modules/@fontsource-variable/noto-emoji/index.css`, "utf8");
let css = `/* Generated from @fontsource-variable/noto-emoji and twemoji-colr-font. Do not edit: run scripts/emoji-css.mjs. Ranges stay on pictographs so digits, ©, ™, arrows and ✓ keep the text font. */\n`;
for (const m of src.matchAll(/url\(\.\/files\/([^)]+)\)[^;]*;\s*unicode-range:\s*([^;]+);/g)) {
  const r = intersect(parse(m[2]));
  if (!r.length) continue;
  css += `@font-face {\n  font-family: "Constella Emoji Mono";\n  font-display: swap;\n  font-weight: 300 700;\n  src: url("../node_modules/@fontsource-variable/noto-emoji/files/${m[1]}") format("woff2");\n  unicode-range: ${fmt(r)};\n}\n`;
}
css += `@font-face {\n  font-family: "Constella Emoji Flat";\n  font-display: swap;\n  src: url("../node_modules/twemoji-colr-font/twemoji.woff2") format("woff2");\n  unicode-range: ${fmt(allowed)};\n}\n`;
css += `@font-face {\n  font-family: "Constella Emoji System";\n  src: local("Apple Color Emoji"), local("Segoe UI Emoji"), local("Noto Color Emoji");\n  unicode-range: ${fmt(allowed)};\n}\n`;
writeFileSync(`${web}/src/emoji.css`, css);
