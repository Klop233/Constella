import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DesktopKind, TextArtifactKind } from "@constella/protocol";
import type { AgentRow, Agents } from "./agents.ts";
import { isTextKind, MAX_ARTIFACT_TEXT, type ArtifactRow, type Artifacts } from "./artifacts.ts";
import type { Containers } from "./containers.ts";
import { config } from "./config.ts";
import type { Db } from "./db.ts";
import { KIND_LABEL, type DesktopRow, type Desktops, type ToolFamily } from "./desktops.ts";
import type { HostCapabilities } from "./hostcaps.ts";
import type { Knowledge } from "./knowledge.ts";
import type { Notifier } from "./notify.ts";
import { HTML_DEFAULT_LIMIT, readPageHtml } from "./pagehtml.ts";
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
  hostcaps: HostCapabilities;
  artifacts: Artifacts;
  /** Whether agents may read page HTML directly (browser_html). */
  browserHtml: () => boolean;
  /** Whether creating / changing (incl. restarting) an instance needs the owner's approval. */
  instanceApproval: () => { create: boolean; update: boolean };
}

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

/** How much of a text artifact one artifact_read returns. */
const READ_CHUNK = 60_000;

/** How long ask_user waits for the owner; stays under the engine's MCP tool timeout (960 s). */
const ASK_WAIT_MS = 14 * 60_000;

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
  const desktop = async (family: ToolFamily = "screen") => {
    const r = run();
    const id = await d.desktops.acquire(agent.id, r.id, family);
    return { id, runId: r.id };
  };
  /** Which instance a result came from, so the agent can tell its instances apart. */
  const on = (id: string) => `\n（实例：${d.desktops.describe(d.desktops.row(id))}）`;
  const mineOrFail = (id: string): DesktopRow => {
    const row = d.desktops.boundTo(agent.id).find((x) => x.id === id);
    if (!row) throw new Error("这个实例没有绑定给你，用 instance_list 查看可用的实例");
    return row;
  };
  /** Refuse to restart an instance out from under someone else. */
  const notInUseByOthers = (row: DesktopRow, runId: string) => {
    const l = JSON.parse(row.lease) as { holder: string; runId?: string };
    if (l.holder === "human") throw new Error(`${d.desktops.describe(row)}主人正在操作，不能修改或重启`);
    if (l.holder === "agent" && l.runId !== runId) throw new Error(`${d.desktops.describe(row)}正被另一个任务使用，不能修改或重启`);
  };
  const approve = async (need: boolean, runId: string, summary: string, reason: string) => {
    if (!need) return;
    // The owner turned this approval on explicitly, so it always goes to them (not the approval mode's policy).
    if (!(await d.runs.requestHubApproval(runId, "desktop", summary, reason, { ownerOnly: true }))) throw new Error("主人没有同意");
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

  // ── asking the owner ─────────────────────────────────────
  server.registerTool(
    "ask_user",
    {
      description:
        "拿不准、需要主人拍板时调用：给出 2-4 个具体选项，主人在手机上点选或直接写回答。最多等 14 分钟；没回复时按推荐项继续推进（主人之后的选择会作为新消息发给你）。能自己查清、自己决定的事不要问。",
      inputSchema: {
        question: z.string().min(2).max(500),
        options: z
          .array(z.object({ label: z.string().min(1).max(60), detail: z.string().max(200).optional() }))
          .min(2)
          .max(4),
        recommended: z.number().int().min(0).max(3).optional().describe("推荐选项的序号（从 0 开始）。只在按它继续是安全、可撤销的时候填"),
      },
    },
    guard(async ({ question, options, recommended }) => {
      const r = run();
      const rec = recommended !== undefined && recommended < options.length ? recommended : undefined;
      const res = await d.runs.requestDecision(r.id, question, options, rec, ASK_WAIT_MS);
      if (res.status === "answered") return text(`主人的回答：${res.answer}`);
      if (res.status === "dismissed") return text("主人没有选，让你自己判断。按你认为最稳妥的做法继续。");
      if (res.status === "ended") return fail("任务已经结束");
      return text(
        rec !== undefined
          ? `主人暂时没有回复。按推荐选项「${options[rec]!.label}」继续推进；如果主人之后改选，会以新消息告诉你。`
          : "主人暂时没有回复。先完成不依赖这个决定的部分；如果非等不可，结束本轮并用一句话说明在等哪个决定，主人回答后会以新消息告诉你。",
      );
    }),
  );

  // ── files & artifacts ────────────────────────────────────
  /** Show what was just delivered in the run's chat, and tell the agent how to refer to it. */
  const delivered = (runId: string, a: ArtifactRow, note?: string) => {
    d.runs.appendFor(runId, { type: "artifact", runId, artifactId: a.id, version: a.version, title: a.title, kind: a.kind, filename: a.filename, size: a.size, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) });
    return text(
      a.version === 1
        ? `已发到聊天：「${a.title}」（成果 id ${a.id}，${a.filename}，${bytes(a.size)}）。之后要更新它，用这个 id 生成新版本。`
        : `已发到聊天：「${a.title}」第 ${a.version} 版（成果 id ${a.id}，${a.filename}，${bytes(a.size)}）。`,
    );
  };
  server.registerTool(
    "send_file",
    {
      description:
        "把文件发到聊天里交给主人：报告、表格、文档、图片、PDF、音视频、压缩包等任何文件。主人能在聊天里直接预览和下载，发过的文件都收进「成果」库并保留每个版本。" +
        "主人看不到你的容器，做出了主人要拿走的文件就用它发送，不要只在回复里写路径。path 是容器里的路径（/workspace 或 /home/agent 下，相对路径按 /workspace 算；目录先打包）。" +
        "更新以前发过的文件时传 artifact_id 生成新版本；同一对话里用同一路径、同一标题重新发送也会自动成为新版本。",
      inputSchema: {
        path: z.string().min(1).max(1000),
        title: z.string().max(120).optional().describe("给主人看的标题，默认用文件名"),
        note: z.string().max(300).optional().describe("一句话说明：这是什么，或这一版改了什么"),
        artifact_id: z.string().max(40).optional().describe("要更新的成果 id"),
      },
    },
    guard(async ({ path: p, title, note, artifact_id }) => {
      const r = run();
      const a = await d.artifacts.fromFile({ agentId: agent.id, runId: r.id, conversationId: r.conversation_id, path: p, title, note, artifactId: artifact_id });
      return delivered(r.id, a, note);
    }),
  );
  server.registerTool(
    "artifact_save",
    {
      description:
        "创建一个文本类成果，或整体重写已有成果（传 artifact_id，生成新版本）。成果直接显示在聊天里，主人能预览、编辑、下载，每个版本都保留。" +
        "适合篇幅较长、主人会反复看或修改的内容：报告、方案、文章、单页 HTML 应用或可视化、脚本、数据表；简短的回答直接写在回复里。" +
        "type：markdown 文档；html 单文件网页（CSS、JS 内联，可引用 CDN）；svg 图；code 代码（填 language）；csv 表格；text 纯文本。只改局部用 artifact_edit。",
      inputSchema: {
        title: z.string().min(1).max(120),
        type: TextArtifactKind,
        content: z.string().min(1).max(MAX_ARTIFACT_TEXT),
        language: z.string().max(30).optional().describe("type=code 时的语言，如 python、typescript、bash"),
        artifact_id: z.string().max(40).optional().describe("要重写的成果 id"),
        note: z.string().max(300).optional().describe("这一版改了什么"),
      },
    },
    guard(async ({ title, type, content, language, artifact_id, note }) => {
      const r = run();
      const a = d.artifacts.saveText({ agentId: agent.id, runId: r.id, conversationId: r.conversation_id, artifactId: artifact_id, title, kind: type, language, content, note, author: "agent" });
      return delivered(r.id, a, note);
    }),
  );
  server.registerTool(
    "artifact_edit",
    {
      description:
        "修改文本类成果的局部，生成新版本：edits 里每一项把 old 替换成 new，old 必须和最新版本里的原文一字不差、且只出现一次（多带点上下文）。主人可能在界面上直接改过内容，拿不准时先 artifact_read。",
      inputSchema: {
        artifact_id: z.string().max(40),
        edits: z
          .array(z.object({ old: z.string().min(1).max(MAX_ARTIFACT_TEXT), new: z.string().max(MAX_ARTIFACT_TEXT) }))
          .min(1)
          .max(50),
        note: z.string().max(300).optional().describe("这一版改了什么"),
      },
    },
    guard(async ({ artifact_id, edits, note }) => {
      const r = run();
      const a = d.artifacts.edit({ agentId: agent.id, artifactId: artifact_id, edits, note, runId: r.id, conversationId: r.conversation_id });
      return delivered(r.id, a, note);
    }),
  );
  server.registerTool(
    "artifact_list",
    { description: "列出你交付过的成果（最近更新的在前），可按标题或文件名搜索。", inputSchema: { query: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(30) } },
    guard(async ({ query, limit }) => {
      const list = d.artifacts.list({ agentId: agent.id, q: query, limit });
      if (!list.length) return text(query ? "没有匹配的成果" : "还没有成果");
      return text(
        list
          .map((a) => `${a.id} | ${a.title} | ${a.kind}${a.language ? `/${a.language}` : ""} | 第 ${a.version} 版 | ${bytes(a.size)} | ${a.updated_at.slice(0, 16).replace("T", " ")} | 对话：${a.conversation_title ?? "—"}`)
          .join("\n"),
      );
    }),
  );
  server.registerTool(
    "artifact_read",
    {
      description:
        "读取一个成果。文本类直接返回内容（默认最新版本，可指定 version；很长时用 offset 分段读）。图片、PDF、表格文件等用 save_to 复制到你的容器里（如 /workspace/in/report.pdf）再处理。",
      inputSchema: {
        artifact_id: z.string().max(40),
        version: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).default(0).describe("从第几个字符开始读"),
        save_to: z.string().max(1000).optional(),
      },
    },
    guard(async ({ artifact_id, version, offset, save_to }) => {
      const a = d.artifacts.owned(agent.id, artifact_id);
      const v = d.artifacts.version(a.id, version);
      const head = `「${a.title}」第 ${v.version} 版${v.version < a.version ? `（最新是第 ${a.version} 版）` : ""}${v.author === "user" ? "（主人编辑）" : ""} · ${v.kind} · ${v.filename} · ${bytes(v.size)}${v.note ? ` · ${v.note}` : ""}`;
      if (save_to) {
        const out = d.artifacts.exportTo(agent.id, a.id, v.version, save_to);
        return text(`${head}\n已保存到 ${out.container}`);
      }
      if (!isTextKind(v.kind)) return text(`${head}\n这不是文本文件；用 save_to 复制到你的容器里再处理。`);
      const { text: body } = d.artifacts.text(a.id, v.version);
      const chunk = body.slice(offset, offset + READ_CHUNK);
      const rest = body.length - offset - chunk.length;
      return text(`${head}\n\n${chunk}${rest > 0 ? `\n\n…（还有 ${rest} 个字符，用 offset=${offset + chunk.length} 继续读）` : ""}`);
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

  // ── instances ────────────────────────────────────────────
  const androidOptions = {
    armTranslation: z.boolean().optional().describe("安卓：运行只有 ARM 版本的 App（多数国内 App 需要）"),
    googlePlay: z.boolean().optional().describe("安卓：带 Google Play 服务和商店"),
    width: z.number().int().min(320).max(3840).optional(),
    height: z.number().int().min(320).max(3840).optional(),
    dpi: z.number().int().min(120).max(640).optional().describe("安卓屏幕密度"),
  };
  server.registerTool(
    "instance_list",
    { description: "列出绑定给你的实例（纯浏览器 / Linux 桌面 / 安卓）：状态、谁在用、哪个是你当前操作的；以及这台服务器能新建哪些类型。", inputSchema: {} },
    guard(async () => {
      const r = currentRun(d.db, agent.id);
      const states: Record<string, string> = { running: "运行中", paused: "已暂停", stopped: "已停止", missing: "未启动", starting: "启动中", error: "异常" };
      const lines = await Promise.all(
        d.desktops.boundTo(agent.id).map(async (row) => {
          const l = JSON.parse(row.lease) as { holder: string; runId?: string };
          const who = l.holder === "human" ? "主人在操作" : l.holder === "agent" ? (l.runId === r?.id ? "你在用" : "另一个任务在用") : "空闲";
          const cur = r && d.desktops.current(r.id) === row.id ? "，当前" : "";
          const o = d.desktops.options(row);
          const extra = row.kind === "android" ? `，${o.backend === "emulator" ? "模拟器" : "Redroid"}${o.armTranslation ? "，ARM 转译" : ""}${o.googlePlay ? "，Google Play" : ""}` : "";
          return `- ${d.desktops.describe(row)}：${states[await d.desktops.state(row.id)] ?? "未知"}，${who}${extra}${cur}`;
        }),
      );
      const caps = d.hostcaps.snapshot();
      const kinds = (Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => {
        const a = caps.kinds[k];
        if (!a.ok) return `- ${KIND_LABEL[k]}（${k}）：不能建，${a.reason ?? ""}`;
        if (k !== "android") return `- ${KIND_LABEL[k]}（${k}）：可以`;
        const b = caps.android.backend!;
        const bc = caps.android[b];
        return `- 安卓（android）：可以，${b === "redroid" ? "Redroid" : "模拟器"}；ARM 转译${bc.arm ? "可用" : "不可用"}，Google Play ${bc.googlePlay ? "可用" : "不可用"}`;
      });
      return text(`${lines.length ? lines.join("\n") : "目前没有实例绑定给你。"}\n\n可以新建的类型：\n${kinds.join("\n")}`);
    }),
  );
  server.registerTool(
    "instance_use",
    { description: "切换当前操作的实例：之后的 desktop_* 操作它；它带浏览器时 browser_* 也操作它。", inputSchema: { id: z.string() } },
    guard(async ({ id }) => {
      const row = d.desktops.use(agent.id, run().id, id);
      return text(`已切换到${d.desktops.describe(row)}。`);
    }),
  );
  server.registerTool(
    "instance_create",
    {
      description:
        "新建一个实例并绑定给你，成为当前实例。kind：browser（纯浏览器，最轻）、desktop（Linux 桌面，可运行其他程序）、android（安卓）。每个实例都占用服务器内存，确实需要时再建；可能需要主人审批。",
      inputSchema: { kind: DesktopKind, name: z.string().min(1).max(40), ...androidOptions, reason: z.string().max(300).describe("为什么需要这个实例") },
    },
    guard(async ({ kind, name, reason, ...options }) => {
      const r = run();
      await approve(d.instanceApproval().create, r.id, `新建${KIND_LABEL[kind]}实例「${name}」`, reason);
      const row = await d.desktops.create({ name, kind, options });
      d.desktops.setAgents(row.id, [...d.desktops.agentIds(row.id), agent.id]);
      d.desktops.use(agent.id, r.id, row.id);
      d.runs.appendFor(r.id, { type: "desktop.action", runId: r.id, desktopId: row.id, action: `新建${KIND_LABEL[kind]}实例「${name}」` });
      return text(`已新建并切换到${d.desktops.describe(row)}。第一次使用时会自动启动${kind === "android" ? "（安卓启动需要一两分钟）" : ""}。`);
    }),
  );
  server.registerTool(
    "instance_update",
    {
      description: "修改你绑定的实例：名字、屏幕尺寸、安卓的 ARM 转译 / Google Play、闲置时的处理。运行中的实例会重启以生效。可能需要主人审批。",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(40).optional(),
        ...androidOptions,
        idleAction: z.enum(["pause", "stop", "none"]).optional().describe("闲置时：pause 暂停（保留内存，恢复快）、stop 停止、none 一直运行"),
        idleMinutes: z.number().int().min(0).max(1440).optional(),
        reason: z.string().max(300),
      },
    },
    guard(async ({ id, name, reason, ...options }) => {
      const r = run();
      const row = mineOrFail(id);
      notInUseByOthers(row, r.id);
      const changed = Object.entries({ name, ...options }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
      if (!changed.length) return fail("没有要修改的内容");
      await approve(d.instanceApproval().update, r.id, `修改实例 ${d.desktops.describe(row)}：${changed.join("，")}`, reason);
      const res = await d.desktops.update(id, { name, options: Object.values(options).some((v) => v !== undefined) ? options : undefined });
      d.runs.appendFor(r.id, { type: "desktop.action", runId: r.id, desktopId: id, action: `修改实例：${changed.join("，")}` });
      return text(`已修改${res.restarted ? "，实例已重启" : ""}。${on(id)}`);
    }),
  );
  server.registerTool(
    "instance_restart",
    { description: "重启你绑定的实例（卡死、无响应、画面异常时）。会关闭里面正在运行的程序；可能需要主人审批。", inputSchema: { id: z.string(), reason: z.string().max(300) } },
    guard(async ({ id, reason }) => {
      const r = run();
      const row = mineOrFail(id);
      notInUseByOthers(row, r.id);
      await approve(d.instanceApproval().update, r.id, `重启实例 ${d.desktops.describe(row)}`, reason);
      await d.desktops.restart(id);
      d.runs.appendFor(r.id, { type: "desktop.action", runId: r.id, desktopId: id, action: "重启实例" });
      return text(`已重启。${on(id)}`);
    }),
  );

  // ── screen (pixels; any instance) ────────────────────────
  server.registerTool(
    "desktop_screenshot",
    { description: "截取当前实例的屏幕。坐标以截图为准；操作前先截图确认位置。", inputSchema: {} },
    guard(async () => {
      const { id } = await desktop();
      const shot = await d.desktops.screenshot(id, { quality: 70 });
      return { content: [{ type: "image", data: shot.data.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `屏幕尺寸 ${shot.screen}${on(id)}` }] };
    }),
  );
  server.registerTool(
    "desktop_action",
    {
      description:
        "在当前实例上执行键鼠操作。type: click/double_click/right_click/move/drag(x,y→x2,y2)/type(text)/key(keys，如 ctrl+l、Enter)/scroll(direction, amount)/wait(seconds)。坐标基于截图。" +
        "安卓实例上：click 是点按，drag 是滑动，scroll 是按方向滑动，right_click 是返回，key 支持 back、home、recents、enter、delete，type 可以直接输入中文。",
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
      return text(`完成。需要确认结果时请再截图。${on(id)}`);
    }),
  );
  server.registerTool(
    "desktop_open_app",
    { description: "在当前实例上启动程序：Linux 桌面上是命令，例如 xfce4-terminal；安卓上是包名，例如 com.android.settings（用 android_apps 查包名）。纯浏览器实例不支持。", inputSchema: { app: z.string().max(200) } },
    guard(async ({ app }) => {
      const { id, runId } = await desktop();
      await d.desktops.launch(id, app);
      logAction(runId, id, `打开 ${app}`);
      return text(`已启动${on(id)}`);
    }),
  );
  server.registerTool(
    "desktop_clipboard",
    { description: "读取当前实例的剪贴板；提供 text 时改为写入。安卓上提供 text 会直接输入到当前输入框，不支持读取。", inputSchema: { text: z.string().max(20000).optional() } },
    guard(async ({ text: t }) => {
      const { id } = await desktop();
      return text(await d.desktops.clipboard(id, t));
    }),
  );
  server.registerTool(
    "desktop_request_help",
    {
      description:
        "需要用户本人操作当前实例时调用（登录、验证码、扫码、支付确认等）。会推送通知并在聊天里显示接管请求，请用户接管，并一直等到用户交还（最多 15 分钟），返回用户留言。",
      inputSchema: { reason: z.string().max(300) },
    },
    guard(async ({ reason }) => {
      const { id, runId } = await desktop();
      const note = await d.desktops.requestHelp(id, runId, agent.name, reason, (t, b, u) => void d.notifier.send(t, b, u, { urgent: true }));
      return text(`用户已交还。${note ? `用户留言：${note}` : ""}请先截图确认当前状态再继续。${on(id)}`);
    }),
  );

  // ── android ──────────────────────────────────────────────
  server.registerTool(
    "android_ui",
    { description: "读取当前安卓实例屏幕上的界面元素（文字、描述、resource-id、是否可点、中心坐标），用来决定点哪里；比截图更准。", inputSchema: {} },
    guard(async () => {
      const { id } = await desktop();
      return text(`${await d.desktops.androidUi(id)}${on(id)}`);
    }),
  );
  server.registerTool(
    "android_apps",
    {
      description: "不带参数时列出当前安卓实例上装的 App（包名和名称）。install 提供 APK 的网址，或你工作目录里的文件路径（如 /workspace/app.apk）时安装它。",
      inputSchema: { install: z.string().max(2000).optional() },
    },
    guard(async ({ install }) => {
      const { id, runId } = await desktop();
      if (!install) {
        const apps = await d.desktops.androidApps(id);
        return text(`${apps.map((a) => `${a.package}${a.label ? ` — ${a.label}` : ""}`).join("\n") || "没有自己安装的 App"}${on(id)}`);
      }
      const apk = await readApk(agent.id, install);
      const pkg = await d.desktops.androidInstall(id, apk);
      logAction(runId, id, `安装 App ${pkg || path.basename(install)}`);
      return text(`已安装 ${pkg}${on(id)}`);
    }),
  );

  // ── browser (DOM) ────────────────────────────────────────
  const page = async () => {
    const { id, runId } = await desktop("web");
    return { page: await d.desktops.page(id), id, runId };
  };
  const pageState = async (p: Awaited<ReturnType<typeof page>>["page"]) => {
    const snap = await p.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "");
    const out = `URL: ${p.url()}\n标题: ${await p.title().catch(() => "")}\n\n${snap}`;
    return out.length > 24000 ? `${out.slice(0, 24000)}\n…（页面过长已截断，可滚动或换更具体的操作）` : out;
  };
  server.registerTool(
    "browser_open",
    { description: "在浏览器实例（或 Linux 桌面实例）的浏览器中打开网址（与用户接管时看到的是同一个浏览器，登录状态共享）。", inputSchema: { url: z.string().url(), newTab: z.boolean().default(false) } },
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
  if (d.browserHtml()) {
    server.registerTool(
      "browser_html",
      {
        description:
          "读取当前网页的 HTML。默认已清理：去掉脚本、样式、未显示的元素和样式类属性，链接转为绝对地址，表单显示当前填写的值（密码打码），iframe 和 shadow DOM 里的内容也会带上。" +
          "获取页面信息（正文、列表、表格、价格、链接地址、表单状态）时优先用它：比截图更快更准，一次拿到整页，不用滚动。" +
          "selector（CSS）只读页面的一部分；includeHidden=true 包含折叠、未显示的内容；raw=true 返回未清理的原始 HTML（含脚本里的嵌入数据，如 JSON-LD）；内容过长时按提示用 offset 继续读。",
        inputSchema: {
          selector: z.string().max(500).optional(),
          includeHidden: z.boolean().default(false),
          raw: z.boolean().default(false),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1000).max(100_000).default(HTML_DEFAULT_LIMIT),
        },
      },
      guard(async (o) => text(await readPageHtml((await page()).page, o))),
    );
  }
  server.registerTool(
    "browser_screenshot",
    { description: d.browserHtml() ? "截取当前网页可见区域。适合看布局、图片、图表或验证码；读文字和数据用 browser_html 更快更准。" : "截取当前网页可见区域。", inputSchema: {} },
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
      const { id } = await desktop("web");
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

const MAX_APK_BYTES = 500 * 1024 ** 2;

/** An APK from a URL or the agent's workspace (paths under /workspace map to its workspace dir on the host). */
async function readApk(agentId: string, src: string): Promise<Buffer> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
    if (!res.ok) throw new Error(`下载失败：${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_APK_BYTES) throw new Error("APK 太大（超过 500 MB）");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_APK_BYTES) throw new Error("APK 太大（超过 500 MB）");
    return buf;
  }
  const workspace = path.join(config.agentsDir, agentId, "workspace");
  const rel = src.startsWith("/workspace/") ? src.slice("/workspace/".length) : src;
  const file = path.resolve(workspace, rel);
  if (!file.startsWith(workspace + path.sep)) throw new Error("只能安装工作目录 /workspace 里的文件，或提供网址");
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`找不到文件 ${src}`);
  if (st.size > MAX_APK_BYTES) throw new Error("APK 太大（超过 500 MB）");
  return fs.readFileSync(file);
}

function bytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
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
