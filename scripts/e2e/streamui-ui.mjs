// Browser check for a streaming UI block: open the conversation the demo just produced, confirm the
// declarative interface really rendered as native components, screenshot it, then click the button the
// agent was asked to include and confirm it started a new turn — the "interaction reaches the agent"
// half of the demo.
//
//   BASE=http://172.17.0.1:8790 CONV=cv-… CDP=ws://… node scripts/e2e/streamui-ui.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://172.17.0.1:8790";
const CONV = process.env.CONV;
const CDP = process.env.CDP;
const SHOTS = process.env.SHOTS ?? "/tmp/constella-streamui";
assert.ok(CONV, "CONV (conversation id) required");
assert.ok(CDP, "CDP endpoint (ws://…) required");
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
const step = (s) => console.log(`▶ ${s}`);

try {
  step("open the conversation");
  await page.goto(`${BASE}/c/${CONV}`, { waitUntil: "networkidle" });

  step("wait for the declarative interface to render");
  const tree = page.locator(".genui").first();
  await tree.waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);

  const counts = {
    nodes: await tree.locator("> *").count(),
    tables: await tree.locator("table").count(),
    cards: await tree.locator("button, div").count(),
    svg: await tree.locator("svg").count(),
  };
  console.log(`  组件容器 ${counts.nodes} 个 · 表格 ${counts.tables} · 图/图标 ${counts.svg}`);
  await page.screenshot({ path: path.join(SHOTS, "01-interface.png") });
  assert.ok(counts.nodes > 0, "the interface rendered nothing");

  step("the interface is interactive: click the button the agent was asked to include");
  const turnsBefore = await page.locator("article").count();
  const button = page.getByRole("button", { name: "就选这个" }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "02-after-click.png") });

  step("a new turn started (the click reached the agent)");
  await page.waitForFunction((n) => document.querySelectorAll("article").length > n, turnsBefore, { timeout: 30_000 }).catch(() => {});
  const turnsAfter = await page.locator("article").count();
  console.log(`  turns ${turnsBefore} → ${turnsAfter}`);
  assert.ok(turnsAfter > turnsBefore, "clicking a button in the interface did not start a new turn");
  await page.screenshot({ path: path.join(SHOTS, "03-new-turn.png") });

  step("light mode renders too");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => document.documentElement.setAttribute("data-mode", "light"));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, "04-light.png") });

  console.log(`errors: ${errors.length ? errors.join(" | ") : "none"}`);
  assert.equal(errors.filter((e) => !/favicon|ResizeObserver/.test(e)).length, 0, `console/page errors: ${errors.join(" | ")}`);
  console.log("✓ streaming UI rendered and its button reached the agent");
} finally {
  await browser.close();
}
