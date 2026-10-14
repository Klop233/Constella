import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerMcp } from "../src/mcp.ts";
import { readPageHtml } from "../src/pagehtml.ts";

/** Playwright's own Chromium, or any build already in its cache (the test is skipped without one). */
function findChromium(): string | undefined {
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  const cached = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse()
        .map((d) => path.join(cache, d, "chrome-linux64", "chrome"))
    : [];
  return [process.env.CHROMIUM_PATH, chromium.executablePath(), ...cached].find((p) => p && fs.existsSync(p));
}

const executablePath = findChromium();

const PAGE = `<!doctype html><html><head><title>商品页</title><style>.x{color:red}</style>
<script>window.__DATA__ = {"sku": 42}</script></head><body>
<nav class="flex gap-4"><a href="/cart" class="text-sm" onclick="track()">购物车</a><a href="javascript:void 0">更多</a></nav>
<div class="a"><div class="b"><div class="c"><h1 data-reactid="1">机械键盘</h1></div></div></div>
<main id="main">
  <table class="t"><tr><th>型号</th><th>价格</th></tr><tr><td>K1</td><td><span class="cur">¥</span><span>399</span></td></tr></table>
  <img src="data:image/png;base64,AAAA" alt="图"> <img src="/img/k1.jpg" alt="K1 正面">
  <button aria-label="收藏"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></button>
  <svg><title>评分 4.5</title><circle r="1"/></svg>
  <div style="display:none">隐藏的旧价格 ¥999</div><ul style="visibility:hidden"><li>收起的菜单</li></ul>
  <react-partial>   </react-partial><i class="icon"></i>   <p>  多余   空格 </p>
  <details><summary>规格</summary><p>87 键</p></details>
</main>
<form action="/buy">
  <input name="qty" type="number" value="1"><input type="hidden" name="csrf" value="secret-token">
  <input name="pw" type="password"><input id="agree" type="checkbox">
  <select name="color"><option>黑</option><option>白</option></select>
  <textarea name="note"></textarea>
</form>
<x-card></x-card>
<iframe src="/frame" width="300" height="100"></iframe><iframe src="/pixel" width="1" height="1"></iframe>
<!-- a comment -->
<script>
  customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<style>p{}</style><p>影子里的库存：12</p>"; } });
</script>
</body></html>`;

describe.skipIf(!executablePath)("page HTML", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath });
    page = await browser.newPage();
    const frames: Record<string, string> = { "/frame": "<p>运费：¥12</p>", "/pixel": "<p>tracker</p>" };
    await page.route("https://shop.test/**", (r) =>
      r.fulfill({ contentType: "text/html; charset=utf-8", body: frames[new URL(r.request().url()).pathname] ?? PAGE }),
    );
    await page.goto("https://shop.test/item/1");
    await page.fill("input[name=qty]", "3");
    await page.fill("input[name=pw]", "hunter2");
    await page.check("#agree");
    await page.selectOption("select", "白");
    await page.fill("textarea", "尽快发货");
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("cleans the page down to content, with live form state and absolute links", async () => {
    const out = await readPageHtml(page);
    expect(out).toMatch(/^URL: https:\/\/shop\.test\/item\/1\n标题: 商品页\n/);
    // Scripts, styles, comments, classes, inline handlers and hidden inputs are gone.
    expect(out).not.toMatch(/__DATA__|color:red|a comment|class=|onclick|secret-token|data-reactid|javascript:/);
    // Links and images become absolute; data URIs are elided.
    expect(out).toContain('<a href="https://shop.test/cart">购物车</a>');
    expect(out).toContain('<img src="https://shop.test/img/k1.jpg" alt="K1 正面">');
    expect(out).toContain('src="data:…"');
    // Needless wrappers collapse, table cells keep their separate values.
    expect(out).toContain("\n<h1>机械键盘</h1>");
    expect(out).toContain("<td><span>¥</span><span>399</span></td>");
    // Icons: unlabeled ones dropped, titled ones kept as a label.
    expect(out).not.toContain("<path");
    expect(out).toContain('<svg aria-label="评分 4.5"></svg>');
    expect(out).toContain('<button aria-label="收藏"></button>');
    // What is currently filled in, with the password masked.
    expect(out).toContain('<input name="qty" type="number" value="3">');
    expect(out).toContain('<input name="pw" type="password" value="••••••">');
    expect(out).not.toContain("hunter2");
    expect(out).toContain('<input id="agree" type="checkbox" checked="">');
    expect(out).toContain('<option selected="">白</option>');
    expect(out).toContain("<textarea name=\"note\">尽快发货</textarea>");
    // Open shadow roots and content iframes are read too; tracking pixels aren't.
    expect(out).toContain("影子里的库存：12");
    expect(out).toContain("<!-- iframe https://shop.test/frame -->\n<body>\n<p>运费：¥12</p></body>");
    expect(out).not.toContain("tracker");
    // Elements that aren't displayed are left out, and the header says so.
    expect(out).not.toContain("¥999");
    expect(out).not.toContain("87 键");
    expect(out).not.toContain("收起的菜单");
    expect(out).toMatch(/已省略 3 个未显示的元素/);
    // Empty leftovers and runs of spaces go.
    expect(out).not.toMatch(/react-partial|<i>|  /);
    expect(out).toContain("<p> 多余 空格 </p>");
  });

  it("includes hidden elements on request", async () => {
    const out = await readPageHtml(page, { includeHidden: true });
    expect(out).toContain("¥999");
    expect(out).toContain("87 键");
    expect(out).toContain("收起的菜单");
    expect(out).not.toContain("已省略");
  });

  it("reads just the matching part of the page", async () => {
    const out = await readPageHtml(page, { selector: "table" });
    expect(out).toContain("范围: table（匹配 1 处）");
    expect(out).toContain("<th>型号</th>");
    expect(out).not.toContain("购物车");
    expect(await readPageHtml(page, { selector: ".nope" })).toContain("没有匹配的元素");
  });

  it("returns raw HTML with scripts when asked", async () => {
    const out = await readPageHtml(page, { raw: true });
    expect(out).toContain("window.__DATA__");
    expect(out).toContain('class="flex gap-4"');
  });

  it("pages long output by characters", async () => {
    const full = (await readPageHtml(page)).split("\n\n").slice(1).join("\n\n");
    const first = await readPageHtml(page, { limit: 300 });
    expect(first).toContain(`共 ${full.length} 字符，本次 0–300；继续读用 offset=300`);
    const rest = await readPageHtml(page, { offset: 300, limit: 100_000 });
    expect(rest).toContain("（已到末尾）");
    expect(first.split("\n\n").slice(1).join("\n\n") + rest.split("\n\n").slice(1).join("\n\n")).toBe(full);
  });

  it("is offered to agents over MCP only while the setting is on", async () => {
    let enabled = true;
    const app = Fastify();
    registerMcp(app, {
      db: { prepare: () => ({ get: () => ({ id: "run-1", conversation_id: "c-1" }) }) },
      agents: { byToken: (t: string) => (t === "tok" ? { id: "a-1", name: "测试", host_access: 0 } : undefined) },
      desktops: { acquire: async () => "d-1", page: async () => page },
      browserHtml: () => enabled,
    } as any);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const connect = async () => {
      const client = new Client({ name: "test", version: "0" });
      const url = new URL(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer tok" } } }));
      return client;
    };
    try {
      const on = await connect();
      const tools = (await on.listTools()).tools;
      expect(tools.map((t) => t.name)).toContain("browser_html");
      expect(tools.find((t) => t.name === "browser_screenshot")?.description).toContain("browser_html");
      const res = (await on.callTool({ name: "browser_html", arguments: { selector: "table" } })) as { content: { text: string }[]; isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(res.content[0]!.text).toContain("<td><span>¥</span><span>399</span></td>");
      await on.close();

      enabled = false;
      const off = await connect();
      const names = (await off.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("browser_html");
      expect(names).toContain("browser_screenshot");
      await off.close();
    } finally {
      await app.close();
    }
  });
});
