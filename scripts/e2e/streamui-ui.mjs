// Browser check for a streaming UI block: open the conversation the demo just produced, confirm the
// declarative interface really rendered as native components (with its text and labels — the two
// things the bridge can silently drop), screenshot it, then click the button the agent was asked to
// include and confirm it started a new turn: the "interaction reaches the agent" half of the demo.
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
const BUTTON = process.env.BUTTON ?? "就选这个";
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
  await tree.waitFor({ timeout: 180_000 });
  await page.waitForTimeout(1500);

  const shapes = {
    blocks: await tree.count(),
    tables: await tree.locator("table").count(),
    svg: await tree.locator("svg").count(),
    images: await tree.locator("img").count(),
  };
  const text = (await tree.innerText()).replace(/\s+/g, " ").trim();
  console.log(`  组件容器 ${shapes.blocks} · 表格 ${shapes.tables} · 图/图标 ${shapes.svg} · 文字 ${text.length} 字`);
  console.log(`  正文：${text.slice(0, 160)}`);
  await page.screenshot({ path: path.join(SHOTS, "01-interface.png") });

  assert.ok(shapes.blocks > 0, "the interface rendered nothing");
  // Text and labels are what the bridge can drop while the tree itself still looks fine.
  assert.ok(text.length > 20, `the interface rendered almost no text: ${JSON.stringify(text)}`);

  const buttons = tree.locator("button");
  const labels = [];
  for (let i = 0; i < (await buttons.count()); i++) labels.push((await buttons.nth(i).innerText()).replace(/\s+/g, " ").trim());
  console.log(`  界面里的按钮：${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.length > 0), "every button in the interface is unlabeled");

  step(`click 「${BUTTON}」`);
  const turnsBefore = await page.locator("article").count();
  const button = page.getByRole("button", { name: BUTTON }).first();
  if (await button.count()) {
    await button.scrollIntoViewIfNeeded();
    await button.click();
  } else {
    console.log(`  （模型没放「${BUTTON}」，点第一个有文字的按钮）`);
    const first = buttons.filter({ hasText: /\S/ }).first();
    await first.scrollIntoViewIfNeeded();
    await first.click();
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, "02-after-click.png") });

  step("a new turn started (the click reached the agent)");
  await page.waitForFunction((n) => document.querySelectorAll("article").length > n, turnsBefore, { timeout: 60_000 }).catch(() => {});
  const turnsAfter = await page.locator("article").count();
  console.log(`  turns ${turnsBefore} → ${turnsAfter}`);
  assert.ok(turnsAfter > turnsBefore, "clicking a button in the interface did not start a new turn");
  await page.screenshot({ path: path.join(SHOTS, "03-new-turn.png") });

  step("light mode renders too");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => document.documentElement.setAttribute("data-mode", "light"));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, "04-light.png") });

  const real = errors.filter((e) => !/favicon|ResizeObserver|Download the React DevTools/.test(e));
  console.log(`errors: ${real.length ? real.join(" | ") : "none"}`);
  assert.equal(real.length, 0, `console/page errors: ${real.join(" | ")}`);
  console.log("✓ streaming UI rendered (text and labels included) and its button reached the agent");
} finally {
  await browser.close();
}
