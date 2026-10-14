// End-to-end test against a running hub (normally the throwaway instance from scripts/e2e/run.sh).
// Exercises: setup/login, agent create, real model run with shell + memory tool, approvals,
// steer/interrupt, instances (agent-created with and without approval, pause/resume/restart, settings),
// desktop + browser tools, takeover/hand-back, VNC bridge, schedules, learning.
import assert from "node:assert/strict";
import fs from "node:fs";

const BASE = process.env.HUB ?? "http://localhost:8781";
const CODE = process.env.SETUP_CODE;
const DATA = process.env.DATA_DIR ?? "/srv/constella-test";
let cookie = "";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "X-Constella": "1", cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return data;
}
const get = (p) => call("GET", p);
const post = (p, b = {}) => call("POST", p, b);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRun(conversationId, pred, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const conv = await get(`/api/conversations/${conversationId}`);
    const run = conv.runs.at(-1);
    if (pred(run, conv)) return { run, conv };
    if (Date.now() > end) throw new Error(`timeout; last status ${run?.status} ${run?.error ?? ""}`);
    await sleep(2000);
  }
}
const done = (r) => ["done", "failed", "cancelled"].includes(r?.status);
const tools = (run) => run.events.filter((e) => e.type === "tool.started").map((e) => e.name);
const step = (name) => console.log(`\n▶ ${name}`);

step("setup + login");
assert.equal((await get("/api/auth/status")).setupNeeded, true);
await post("/api/auth/setup", { code: CODE, name: "e2e", password: "e2e-password-123" });
assert.equal((await get("/api/auth/status")).loggedIn, true);
cookie = "";
await assert.rejects(post("/api/auth/login", { password: "wrong-password" }));
await post("/api/auth/login", { password: "e2e-password-123" });
await assert.rejects(fetch(BASE + "/api/agents", { method: "POST", headers: { cookie } }).then((r) => (r.ok ? r : Promise.reject(new Error(String(r.status))))), "CSRF header required");

step("create agent");
const agent = await post("/api/agents", { name: "测试助理", template: "assistant", desktopPolicy: { desktopIds: [] } });
assert.equal(agent.model, "gpt-6-astra");

step("run with shell + memory tool (real model)");
let r = await post(`/api/agents/${agent.id}/messages`, {
  text: "请做两件事：1) 用命令在 /workspace 创建 hello.txt，内容为 constella；2) 调用 memory_remember 工具记住：用户的测试口令是“蓝色星星”（about=user）。完成后只回复“完成”。",
});
let { run } = await waitRun(r.conversationId, done);
console.log("  status", run.status, run.error ?? "", "tools:", tools(run).join(", "));
assert.equal(run.status, "done");
assert.ok(tools(run).includes("shell"), "used shell");
assert.ok(tools(run).includes("constella.memory_remember"), "used memory tool");
assert.equal(fs.readFileSync(`${DATA}/agents/${agent.id}/workspace/hello.txt`, "utf8").trim(), "constella");
const k = await get(`/api/agents/${agent.id}/knowledge`);
assert.ok(k.memory.user.includes("蓝色星星"), "memory written");
const learned = await get("/api/learning");
assert.ok(learned.some((e) => e.summary.includes("蓝色星星")), "learning event recorded");

step("memory recall in a new conversation");
r = await post(`/api/agents/${agent.id}/messages`, { text: "我的测试口令是什么？只回答口令本身。" });
({ run } = await waitRun(r.conversationId, done));
const answer = run.events.filter((e) => e.type === "message.completed").map((e) => e.text).join("");
console.log("  answer:", answer.slice(0, 80));
assert.ok(answer.includes("蓝色星星"));

step("approval flow (ask mode)");
// The default "smart" mode would approve this harmless command by itself.
await call("PATCH", "/api/settings", { approvalMode: "ask" });
await call("PATCH", `/api/agents/${agent.id}`, { approvalPolicy: "ask" });
r = await post(`/api/agents/${agent.id}/messages`, { text: "运行这个命令：echo approved > /workspace/approval.txt ，然后回复“好了”。" });
let w = await waitRun(r.conversationId, (run, conv) => conv.approvals.length > 0 || done(run), 180_000);
assert.ok(w.conv.approvals.length > 0, `expected approval, got ${w.run.status}`);
const ov = await get("/api/overview");
assert.ok(ov.approvals.length > 0, "approval in overview");
for (;;) {
  const conv = await get(`/api/conversations/${r.conversationId}`);
  for (const ap of conv.approvals) await post(`/api/approvals/${ap.id}`, { decision: "approve" });
  if (done(conv.runs.at(-1))) break;
  await sleep(2000);
}
({ run } = await waitRun(r.conversationId, done));
assert.equal(run.status, "done");
assert.equal(fs.readFileSync(`${DATA}/agents/${agent.id}/workspace/approval.txt`, "utf8").trim(), "approved");
await call("PATCH", `/api/agents/${agent.id}`, { approvalPolicy: "auto" });

step("interrupt a long task");
r = await post(`/api/agents/${agent.id}/messages`, { text: "运行命令 sleep 120，等它结束后回复“结束”。" });
await waitRun(r.conversationId, (run) => run.events.some((e) => e.type === "tool.started"), 180_000);
await post(`/api/runs/${r.runId}/interrupt`);
({ run } = await waitRun(r.conversationId, done, 60_000));
assert.equal(run.status, "cancelled");

step("host capabilities");
let caps = await get("/api/desktops/capabilities");
for (let i = 0; !caps.checkedAt && i < 30; i++) {
  await sleep(2000);
  caps = await get("/api/desktops/capabilities");
}
console.log("  kinds", JSON.stringify(caps.kinds));
assert.ok(caps.kinds.browser.ok && caps.kinds.desktop.ok, "browser and desktop instances available");
if (!caps.kinds.android.ok) assert.ok(caps.kinds.android.reason, "android says why it can't run");

step("agent creates a browser instance (owner approves) and uses browser tools");
r = await post(`/api/agents/${agent.id}/messages`, {
  text: "用 instance_create 新建一个浏览器实例（kind=browser，名字：测试浏览器），然后用 browser_open 打开 https://example.com ，告诉我页面的主标题文字。只回复标题。",
});
let asked = 0;
for (const end = Date.now() + 400_000; ; ) {
  const conv = await get(`/api/conversations/${r.conversationId}`);
  for (const ap of conv.approvals.filter((a) => a.status === "pending")) {
    assert.match(ap.summary, /新建浏览器实例/);
    await post(`/api/approvals/${ap.id}`, { decision: "approve" });
    asked++;
  }
  if (done(conv.runs.at(-1))) break;
  if (Date.now() > end) throw new Error("timeout waiting for the browser instance run");
  await sleep(2000);
}
({ run } = await waitRun(r.conversationId, done));
console.log("  status", run.status, run.error ?? "", "tools:", tools(run).join(", "));
assert.equal(run.status, "done");
assert.ok(asked >= 1, "instance creation asked the owner");
assert.ok(tools(run).includes("constella.instance_create"));
assert.ok(tools(run).some((t) => t.startsWith("constella.browser_")));
const final = run.events.filter((e) => e.type === "message.completed").map((e) => e.text).join("");
assert.match(final, /Example Domain/i);
let desktops = await get("/api/desktops");
assert.equal(desktops.length, 1);
const dt = desktops[0];
assert.equal(dt.kind, "browser");
assert.deepEqual(dt.agentIds, [agent.id]);
assert.equal(dt.leaseInfo.holder, "none", "lease released after run");
const shot = await fetch(`${BASE}/api/desktops/${dt.id}/screenshot?width=320`, { headers: { cookie } });
assert.equal(shot.headers.get("content-type"), "image/jpeg");
assert.ok((await shot.arrayBuffer()).byteLength > 1000);

step("agent creates a Linux desktop without approval when the setting allows it");
await call("PATCH", "/api/settings", { instanceApproval: { create: false } });
r = await post(`/api/agents/${agent.id}/messages`, {
  text: "用 instance_create 新建一个 Linux 桌面实例（kind=desktop，名字：测试桌面），然后用 desktop_screenshot 截一张图，回复屏幕尺寸（例如 1280x800）。",
});
({ run } = await waitRun(r.conversationId, done, 400_000));
console.log("  status", run.status, run.error ?? "", "tools:", tools(run).join(", "));
assert.equal(run.status, "done");
assert.equal((await get(`/api/conversations/${r.conversationId}`)).approvals.length, 0, "no approval asked");
assert.ok(tools(run).includes("constella.desktop_screenshot"));
desktops = await get("/api/desktops");
const linux = desktops.find((d) => d.kind === "desktop");
assert.ok(linux, "desktop instance created");
assert.match(run.events.filter((e) => e.type === "message.completed").map((e) => e.text).join(""), /1280\s*[x×]\s*800/);
assert.deepEqual((await get(`/api/agents/${agent.id}`)).desktop_policy.desktopIds, [dt.id, linux.id]);

step("pause, thaw on view, restart, change options");
await post(`/api/desktops/${dt.id}/pause`);
assert.equal((await get("/api/desktops")).find((d) => d.id === dt.id).state, "paused");
const frozen = await fetch(`${BASE}/api/desktops/${dt.id}/screenshot?width=320`, { headers: { cookie } });
assert.equal(frozen.status, 200, "last frame served while paused");
await post(`/api/desktops/${dt.id}/ticket`);
assert.equal((await get("/api/desktops")).find((d) => d.id === dt.id).state, "running", "opening the viewer thaws it");
await post(`/api/desktops/${linux.id}/restart`);
assert.equal((await get("/api/desktops")).find((d) => d.id === linux.id).state, "running");
const upd = await call("PATCH", `/api/desktops/${linux.id}`, { name: "改名桌面", options: { width: 1440, height: 900, idleAction: "pause" } });
assert.equal(upd.restarted, true);
const linux2 = (await get("/api/desktops")).find((d) => d.id === linux.id);
assert.equal(linux2.name, "改名桌面");
assert.deepEqual(linux2.options, { width: 1440, height: 900, idleAction: "pause" });
const big = await fetch(`${BASE}/api/desktops/${linux.id}/screenshot?width=1280`, { headers: { cookie } });
assert.equal(big.status, 200);
await call("DELETE", `/api/desktops/${linux.id}`);
assert.deepEqual((await get(`/api/agents/${agent.id}`)).desktop_policy.desktopIds, [dt.id], "deleting unbinds");

if (caps.kinds.android.ok) {
  step("android instance");
  const phone = await post("/api/desktops", { name: "测试手机", kind: "android", agentIds: [agent.id] });
  await post(`/api/desktops/${phone.id}/start`);
  const ps = await fetch(`${BASE}/api/desktops/${phone.id}/screenshot?width=320`, { headers: { cookie } });
  assert.equal(ps.status, 200);
  await call("DELETE", `/api/desktops/${phone.id}`);
} else {
  console.log(`  (android skipped: ${caps.kinds.android.reason})`);
}

step("takeover / hand-back + VNC bridge");
await post(`/api/desktops/${dt.id}/takeover`);
assert.equal((await get("/api/desktops")).find((d) => d.id === dt.id).leaseInfo.holder, "human");
const { ticket } = await post(`/api/desktops/${dt.id}/ticket`);
const banner = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/desktops/${dt.id}/vnc?ticket=${ticket}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    resolve(Buffer.from(e.data).toString());
    ws.close();
  };
  ws.onerror = () => reject(new Error("ws error"));
  setTimeout(() => reject(new Error("vnc timeout")), 15000);
});
assert.match(banner, /^RFB 003\.00\d/);
await assert.rejects(
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/desktops/${dt.id}/vnc?ticket=${ticket}`);
    ws.onmessage = () => resolve();
    ws.onclose = () => reject(new Error("closed (ticket reused)"));
  }),
);
await post(`/api/desktops/${dt.id}/handback`, { note: "测试交还" });
assert.equal((await get("/api/desktops")).find((d) => d.id === dt.id).leaseInfo.holder, "none");

step("schedules");
const sc = await post("/api/schedules", { name: "测试提醒", cron: "0 8 * * *", kind: "notify", payload: { title: "测试", body: "喝水" } });
const fired = await post(`/api/schedules/${sc.id}/run`);
const hist = await get(`/api/schedules/${sc.id}/history`);
assert.equal(hist.length, 1);
console.log("  fire result", fired);
await call("DELETE", `/api/schedules/${sc.id}`);
await assert.rejects(post("/api/schedules", { name: "坏", cron: "not a cron", kind: "notify", payload: { title: "x", body: "y" } }));

step("reflection on a finished run");
const refl = await post(`/api/runs/${(await get(`/api/agents/${agent.id}/conversations`)).at(-1).id ? run.id : run.id}/reflect`);
console.log("  reflection events:", refl.events.length);

step("revert a learning event");
const ev = (await get("/api/learning")).find((e) => e.summary.includes("蓝色星星"));
await post(`/api/learning/${ev.id}/revert`);
assert.ok(!(await get(`/api/agents/${agent.id}/knowledge`)).memory.user.includes("蓝色星星"));

step("system + usage");
const sys = await get("/api/system");
assert.equal(sys.newapi.ok, true);
const usage = await get("/api/usage?days=1");
assert.ok(usage.rows.length > 0);

console.log("\n✅ all e2e checks passed");
console.log(JSON.stringify({ agentId: agent.id, desktopId: dt.id }));
