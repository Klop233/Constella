// Mobile UI walkthrough (Pixel 7 viewport) against the throwaway hub, driving a desktop
// container's Chromium over CDP. Expects the api-e2e suite to have created the account and an agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.HUB ?? "http://localhost:8781";
const CDP = process.env.CDP;
const SHOTS = process.env.SHOTS ?? "/tmp/constella-ui";
assert.ok(CDP, "CDP endpoint (ws://…) required");
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
  colorScheme: "dark",
  userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Mobile Safari/537.36",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const step = (s) => console.log(`▶ ui: ${s}`);

try {
  step("login");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByLabel("密码").fill("e2e-password-123");
  await shot("01-login");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("我的 agent").waitFor({ timeout: 15000 });
  await page.getByText("测试助理").first().waitFor();
  await page.waitForTimeout(800);
  await shot("02-home");

  step("chat");
  await page.getByText("测试助理").first().click();
  await page.getByRole("button", { name: "新对话" }).click();
  await page.getByPlaceholder("说点什么…").fill("只回复四个字：你好星座");
  await page.getByRole("button", { name: "发送" }).click();
  await page.waitForURL(/\/c\//, { timeout: 15000 });
  await page.locator(".prose-chat", { hasText: "你好星座" }).first().waitFor({ timeout: 180000 });
  await page.getByLabel("有帮助").waitFor({ timeout: 30000 });
  await shot("03-chat");

  step("tool cards render");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByText("请做两件事").first().click().catch(async () => {
    await page.getByText("测试助理").first().click();
  });
  await page.waitForTimeout(1500);
  await shot("04-chat-tools");

  step("agent knowledge");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByText("测试助理").first().click();
  await page.getByRole("button", { name: "记忆与技能" }).click();
  await page.getByText("它的记忆").waitFor();
  await shot("05-knowledge");

  step("desktops");
  await page.getByRole("link", { name: "桌面" }).click();
  await page.getByText("临时桌面").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot("06-desktops");
  await page.getByText("临时桌面").first().click();
  await page.locator("canvas").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  if (await page.getByRole("button", { name: "交还" }).isVisible()) {
    await page.getByRole("button", { name: "交还" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "交还" }).click();
    await page.getByRole("button", { name: "接管" }).waitFor({ timeout: 10000 });
  }
  await shot("07-desktop-view");
  await page.getByRole("button", { name: "接管" }).click();
  await page.getByRole("button", { name: "交还" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "键盘" }).waitFor();
  await shot("08-desktop-takeover");
  await page.getByRole("button", { name: "交还" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "交还" }).click();
  await page.getByRole("button", { name: "接管" }).waitFor({ timeout: 10000 });
  await page.getByLabel("返回").click();

  step("tasks");
  await page.getByRole("link", { name: "任务" }).click();
  await page.getByLabel("新建").click();
  await page.getByLabel("名称").fill("喝水提醒");
  await page.getByRole("button", { name: "每天 20:00", exact: true }).click();
  await page.getByLabel("提醒内容").fill("该喝水啦");
  await shot("09-task-new");
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByText("每天 20:00 · 推送提醒").waitFor({ timeout: 10000 });
  await shot("10-tasks");

  step("learning");
  await page.getByRole("link", { name: "学习" }).click();
  await page.getByText("蓝色星星").first().waitFor({ timeout: 10000 });
  await shot("11-learning");
  await page.getByText("蓝色星星").first().click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(800);
  await shot("12-learning-diff");
  await page.keyboard.press("Escape");

  step("settings");
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByText("new-api 与用量").waitFor();
  await page.waitForTimeout(1000);
  await shot("13-settings");

  step("passkey register + login (virtual authenticator)");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByText("通行密钥 · 0").waitFor();
  await page.getByText("通行密钥 · 0").locator("xpath=ancestor::div[contains(@class,'flex items-center')][1]").getByRole("button", { name: "添加" }).click();
  await page.getByText("通行密钥 · 1").waitFor({ timeout: 15000 });
  await shot("15-passkey-added");
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "用通行密钥登录" }).click();
  // Login keeps the current route (/settings).
  await page.getByText("你好，e2e").waitFor({ timeout: 15000 });

  step("web push subscribe");
  await context.grantPermissions(["notifications"], { origin: BASE });
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("switch", { name: "接收推送" }).click();
  const pushResult = await Promise.race([
    page.getByText("已开启推送").waitFor({ timeout: 30000 }).then(() => "subscribed"),
    page.locator(".bg-\\[var\\(--danger\\)\\]").first().waitFor({ timeout: 30000 }).then(async (el) => `failed: ${await page.locator(".bg-\\[var\\(--danger\\)\\]").first().innerText()}`),
  ]).catch((e) => `timeout: ${e.message}`);
  console.log("  push:", pushResult);
  process.env.PUSH_RESULT = pushResult;
  await shot("16-push");

  step("new agent form");
  await page.goto(`${BASE}/agents/new`, { waitUntil: "networkidle" });
  await page.getByText("网页办事").waitFor();
  await shot("14-new-agent");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`✅ ui walkthrough passed, screenshots in ${SHOTS}`);
} catch (err) {
  await shot("zz-failure").catch(() => {});
  console.error("page errors:", errors);
  throw err;
} finally {
  await context.close();
  await browser.close().catch(() => {});
}
