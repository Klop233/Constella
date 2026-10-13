import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentRow, Agents } from "./agents.ts";
import type { Containers } from "./containers.ts";
import type { Db } from "./db.ts";
import type { Desktops } from "./desktops.ts";
import type { Knowledge } from "./knowledge.ts";
import type { Notifier } from "./notify.ts";
import type { RunManager, RunRow } from "./runs.ts";
import type { Scheduler } from "./scheduler.ts";

export interface McpDeps {
  db: Db;
  agents: Agents;
  runs: RunManager;
  knowledge: Knowledge;
  desktops: Desktops;
  notifier: Notifier;
  scheduler: Scheduler;
  containers: Containers;
}

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

/** Read-only host commands that skip approval (single command, no shell operators). */
const HOST_READONLY =
  /^(ls|cat|head|tail|df|du|free|uptime|uname|whoami|hostname|ps|top -bn1|ss -[a-z]+|ip (a|addr|route)|docker (ps|images|logs|inspect|stats --no-stream)|systemctl (status|list-units|is-active)|journalctl|lsblk|date|env|which|stat|wc|grep|find)\b[^;&|`$<>]*$/;

/** The run a tool call belongs to: the agent's most recent active run. */
function currentRun(db: Db, agentId: string): RunRow | undefined {
  return db
    .prepare(
      "SELECT * FROM runs WHERE agent_id = ? AND status IN ('running','waiting_approval','paused_by_user') ORDER BY last_event_at DESC LIMIT 1",
    )
    .get(agentId) as RunRow | undefined;
}

function buildServer(agent: AgentRow, d: McpDeps): McpServer {
  const server = new McpServer({ name: "constella", version: "0.1.0" });
  const run = () => {
    const r = currentRun(d.db, agent.id);
    if (!r) throw new Error("没有正在进行的任务");
    return r;
  };
  const guard =
    <A,>(fn: (args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };
  const desktop = async () => {
    const r = run();
    const id = await d.desktops.acquire(agent.id, r.id);
    return { id, runId: r.id };
  };
  const logAction = (runId: string, desktopId: string, action: string) =>
    d.runs.appendFor(runId, { type: "desktop.action", runId, desktopId, action });

  // ── memory ───────────────────────────────────────────────
  server.registerTool(
    "memory_remember",
    {
      description: "把一条长期有用的事实写入记忆。about=user 表示关于用户本人（所有 agent 共享），about=agent 表示你自己的工作经验。",
      inputSchema: { text: z.string().max(300), about: z.enum(["agent", "user"]).default("agent") },
    },
    guard(async ({ text: t, about }) => {
      const evs = d.knowledge.apply(agent.id, { memory: [{ op: "add", scope: about, text: t }] }, { runId: currentRun(d.db, agent.id)?.id ?? null, reason: "tool" });
      return text(evs.length ? "已记住" : "已存在相同或相近的记忆，未重复添加（或记忆已满，需要先整理）");
    }),
  );
  server.registerTool(
    "memory_forget",
    {
      description: "删除包含指定片段的一条记忆。",
      inputSchema: { match: z.string().max(200), about: z.enum(["agent", "user"]).default("agent") },
    },
    guard(async ({ match, about }) => {
      const evs = d.knowledge.apply(agent.id, { memory: [{ op: "delete", scope: about, match }] }, { runId: currentRun(d.db, agent.id)?.id ?? null, reason: "tool" });
      return text(evs.length ? "已删除" : "没有找到匹配的记忆");
    }),
  );
  server.registerTool(
    "memory_list",
    { description: "查看当前的全部记忆（你自己的和关于用户的）。", inputSchema: {} },
    guard(async () => {
      const m = d.knowledge.memory(agent.id);
      return text(`## 你的记忆\n${m.agent}\n\n## 关于用户\n${m.user}`);
    }),
  );

  // ── notifications & schedules ────────────────────────────
  server.registerTool(
    "notify_user",
    { description: "向用户手机推送一条通知。", inputSchema: { title: z.string().max(80), body: z.string().max(500) } },
    guard(async ({ title, body }) => {
      const r = currentRun(d.db, agent.id);
      const res = await d.notifier.send(title, body, r ? `/c/${r.conversation_id}` : "/");
      return text(`已发送（推送设备 ${res.push} 个${res.telegram ? "，Telegram 已发送" : ""}）`);
    }),
  );
  server.registerTool(
    "schedule_create",
    {
      description:
        "创建定时任务。cron 为 5 段 cron 表达式（时区 Asia/Shanghai）。message 不为空时只推送这条消息（适合提醒）；否则在时间到时让你执行 prompt。",
      inputSchema: {
        name: z.string().max(60),
        cron: z.string().max(60),
        prompt: z.string().max(2000).optional(),
        message: z.string().max(500).optional(),
      },
    },
    guard(async ({ name, cron, prompt, message }) => {
      if (!prompt && !message) return fail("prompt 和 message 至少提供一个");
      const s = d.scheduler.create(
        message
          ? { name, cron, kind: "notify", agentId: agent.id, payload: { title: name, body: message } }
          : { name, cron, kind: "agent_prompt", agentId: agent.id, payload: { text: prompt! } },
        `agent:${agent.id}`,
      );
      return text(`已创建定时任务 ${s.id}，下次执行：${d.scheduler.nextRun(s.id) ?? "未知"}`);
    }),
  );
  server.registerTool(
    "schedule_list",
    { description: "列出你创建的定时任务。", inputSchema: {} },
    guard(async () => {
      const list = d.scheduler.list().filter((s) => s.agent_id === agent.id);
      return text(list.length ? list.map((s) => `${s.id} | ${s.name} | ${s.cron} | ${s.enabled ? "启用" : "停用"}`).join("\n") : "没有定时任务");
    }),
  );
  server.registerTool(
    "schedule_delete",
    { description: "删除你创建的一个定时任务。", inputSchema: { id: z.string() } },
    guard(async ({ id }) => {
      const s = d.scheduler.list().find((x) => x.id === id);
      if (!s || s.agent_id !== agent.id) return fail("找不到该定时任务");
      d.scheduler.remove(id, `agent:${agent.id}`);
      return text("已删除");
    }),
  );

  // ── desktop (pixels) ─────────────────────────────────────
  server.registerTool(
    "desktop_screenshot",
    { description: "截取桌面画面（1280×800 坐标系）。操作前先截图确认位置。", inputSchema: {} },
    guard(async () => {
      const { id } = await desktop();
      const shot = await d.desktops.screenshot(id, { quality: 70 });
      return { content: [{ type: "image", data: shot.data.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `屏幕尺寸 ${shot.screen}` }] };
    }),
  );
  server.registerTool(
    "desktop_action",
    {
      description:
        "在桌面上执行键鼠操作。type: click/double_click/right_click/move/drag(x,y→x2,y2)/type(text)/key(keys，如 ctrl+l、Enter)/scroll(direction, amount)/wait(seconds)。坐标基于截图。",
      inputSchema: {
        type: z.enum(["click", "double_click", "right_click", "middle_click", "move", "drag", "type", "key", "scroll", "wait"]),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        x2: z.number().int().optional(),
        y2: z.number().int().optional(),
        text: z.string().max(5000).optional(),
        keys: z.string().max(60).optional(),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        amount: z.number().int().min(1).max(30).optional(),
        seconds: z.number().min(0).max(30).optional(),
      },
    },
    guard(async (a) => {
      const { id, runId } = await desktop();
      await d.desktops.action(id, a);
      logAction(runId, id, describeAction(a));
      return text("完成。需要确认结果时请再截图。");
    }),
  );
  server.registerTool(
    "desktop_open_app",
    { description: "在桌面上启动程序，例如 xfce4-terminal、chromium。", inputSchema: { app: z.string().max(200) } },
    guard(async ({ app }) => {
      const { id, runId } = await desktop();
      await d.desktops.launch(id, app);
      logAction(runId, id, `打开 ${app}`);
      return text("已启动");
    }),
  );
  server.registerTool(
    "desktop_clipboard",
    { description: "读取桌面剪贴板；提供 text 时改为写入。", inputSchema: { text: z.string().max(20000).optional() } },
    guard(async ({ text: t }) => {
      const { id } = await desktop();
      return text(await d.desktops.clipboard(id, t));
    }),
  );
  server.registerTool(
    "desktop_request_help",
    {
      description:
        "需要用户本人操作时调用（登录、验证码、扫码、支付确认等）。会推送通知请用户接管桌面，并一直等到用户交还（最多 15 分钟），返回用户留言。",
      inputSchema: { reason: z.string().max(300) },
    },
    guard(async ({ reason }) => {
      const { id } = await desktop();
      const note = await d.desktops.requestHelp(id, agent.name, reason, (t, b, u) => void d.notifier.send(t, b, u, { urgent: true }));
      return text(`用户已交还桌面。${note ? `用户留言：${note}` : ""}请先截图确认当前状态再继续。`);
    }),
  );

  // ── browser (DOM) ────────────────────────────────────────
  const page = async () => {
    const { id, runId } = await desktop();
    return { page: await d.desktops.page(id), id, runId };
  };
  const pageState = async (p: Awaited<ReturnType<typeof page>>["page"]) => {
    const snap = await p.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "");
    const out = `URL: ${p.url()}\n标题: ${await p.title().catch(() => "")}\n\n${snap}`;
    return out.length > 24000 ? `${out.slice(0, 24000)}\n…（页面过长已截断，可滚动或换更具体的操作）` : out;
  };
  server.registerTool(
    "browser_open",
    { description: "在桌面浏览器中打开网址（与用户接管时看到的是同一个浏览器，登录状态共享）。", inputSchema: { url: z.string().url(), newTab: z.boolean().default(false) } },
    guard(async ({ url, newTab }) => {
      let { page: p, id, runId } = await page();
      if (newTab) p = await p.context().newPage();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await p.bringToFront();
      logAction(runId, id, `打开网页 ${url}`);
      return text(await pageState(p));
    }),
  );
  server.registerTool(
    "browser_snapshot",
    { description: "读取当前网页的结构（无障碍树），用于决定点击什么。", inputSchema: {} },
    guard(async () => text(await pageState((await page()).page))),
  );
  server.registerTool(
    "browser_click",
    {
      description: "点击网页元素。优先用 role+name（来自 snapshot，如 role=button name=登录），其次 text，最后 selector（CSS）。",
      inputSchema: { role: z.string().optional(), name: z.string().optional(), text: z.string().optional(), selector: z.string().optional() },
    },
    guard(async ({ role, name, text: t, selector }) => {
      const { page: p, id, runId } = await page();
      const loc = role ? p.getByRole(role as any, name ? { name } : {}) : t ? p.getByText(t) : selector ? p.locator(selector) : null;
      if (!loc) return fail("需要提供 role、text 或 selector");
      await loc.first().click({ timeout: 15_000 });
      await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      logAction(runId, id, `点击 ${name ?? t ?? selector}`);
      return text(await pageState(p));
    }),
  );
  server.registerTool(
    "browser_type",
    {
      description: "在输入框中填写文字。用 label、placeholder、role+name 或 selector 定位；submit=true 时随后按回车。",
      inputSchema: {
        text: z.string().max(5000),
        label: z.string().optional(),
        placeholder: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
        selector: z.string().optional(),
        submit: z.boolean().default(false),
      },
    },
    guard(async ({ text: t, label, placeholder, role, name, selector, submit }) => {
      const { page: p, id, runId } = await page();
      const loc = label
        ? p.getByLabel(label)
        : placeholder
          ? p.getByPlaceholder(placeholder)
          : role
            ? p.getByRole(role as any, name ? { name } : {})
            : selector
              ? p.locator(selector)
              : null;
      if (!loc) return fail("需要提供 label、placeholder、role 或 selector");
      await loc.first().fill(t, { timeout: 15_000 });
      if (submit) await loc.first().press("Enter");
      await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      logAction(runId, id, `输入文字${submit ? "并提交" : ""}`);
      return text(await pageState(p));
    }),
  );
  server.registerTool(
    "browser_press",
    { description: "在当前网页按键，例如 Enter、Escape、PageDown、Control+A。", inputSchema: { key: z.string().max(40) } },
    guard(async ({ key }) => {
      const { page: p } = await page();
      await p.keyboard.press(key);
      return text(await pageState(p));
    }),
  );
  server.registerTool(
    "browser_screenshot",
    { description: "截取当前网页可见区域。", inputSchema: {} },
    guard(async () => {
      const { page: p } = await page();
      const buf = await p.screenshot({ type: "jpeg", quality: 70, timeout: 20_000 });
      return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] };
    }),
  );
  server.registerTool(
    "browser_tabs",
    { description: "列出浏览器标签页；提供 index 时切换到该标签。", inputSchema: { index: z.number().int().min(0).optional() } },
    guard(async ({ index }) => {
      const { id } = await desktop();
      const pages = await d.desktops.pages(id);
      if (index !== undefined) {
        const p = pages[index];
        if (!p) return fail("没有这个标签页");
        await p.bringToFront();
        return text(await pageState(p));
      }
      return text((await Promise.all(pages.map(async (p, i) => `${i}: ${await p.title().catch(() => "")} — ${p.url()}`))).join("\n"));
    }),
  );
  server.registerTool(
    "browser_back",
    { description: "浏览器后退。", inputSchema: {} },
    guard(async () => {
      const { page: p } = await page();
      await p.goBack({ timeout: 15_000 }).catch(() => {});
      return text(await pageState(p));
    }),
  );

  // ── host access ──────────────────────────────────────────
  if (agent.host_access) {
    server.registerTool(
      "host_exec",
      {
        description: "在宿主服务器上执行一条 shell 命令（以 root 身份）。只读命令自动放行；其余需要用户审批，请在 reason 里说明目的。",
        inputSchema: { command: z.string().max(4000), reason: z.string().max(300) },
      },
      guard(async ({ command, reason }) => {
        const r = run();
        const readonly = HOST_READONLY.test(command.trim());
        if (!readonly) {
          const ok = await d.runs.requestHubApproval(r.id, "host_access", `宿主机命令：${command.slice(0, 300)}`, reason);
          if (!ok) return fail("用户拒绝执行该命令");
        }
        const res = await d.containers.hostExec(command);
        return text(`exit ${res.exitCode}\n${res.output}`);
      }),
    );
  }
  return server;
}

function describeAction(a: { type: string; x?: number; y?: number; text?: string; keys?: string; direction?: string }): string {
  switch (a.type) {
    case "type":
      return `输入 ${a.text?.length ?? 0} 个字符`;
    case "key":
      return `按键 ${a.keys}`;
    case "scroll":
      return `滚动 ${a.direction ?? "down"}`;
    case "wait":
      return "等待";
    default:
      return `${a.type} (${a.x ?? "-"}, ${a.y ?? "-"})`;
  }
}

/** Streamable-HTTP MCP endpoint (stateless: a fresh server per request), authenticated by agent token. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const handler = async (req: any, reply: any) => {
    const auth = String(req.headers.authorization ?? "");
    const agent = auth.startsWith("Bearer ") ? deps.agents.byToken(auth.slice(7)) : undefined;
    if (!agent) return reply.code(401).send({ error: "unauthorized" });
    if (req.method !== "POST") return reply.code(405).header("Allow", "POST").send({ error: "method not allowed" });
    const server = buildServer(agent, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.route({ method: ["GET", "POST", "DELETE"], url: "/mcp", handler });
}
