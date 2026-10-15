import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DesktopPolicy, LegacyDesktopPolicy, ApprovalPolicy } from "@constella/protocol";
import { z } from "zod";
import { changesOf } from "./audit.ts";
import { EffortSchema } from "./catalog.ts";
import { config, newId, nowIso } from "./config.ts";
import { audit, type Db } from "./db.ts";
import type { Knowledge } from "./knowledge.ts";
import type { SecretStore } from "./secrets.ts";

export interface AgentRow {
  id: string;
  name: string;
  emoji: string;
  template: string;
  persona: string;
  model: string;
  effort: string | null;
  approval_policy: "auto" | "ask";
  desktop_policy: string;
  host_access: number;
  token_hash: string;
  newapi_token_id: number | null;
  budget_daily_usd: number | null;
  created_at: string;
  updated_at: string;
  archived: number;
}

/** An agent row in the shape of the edit form, minus secrets, for the before/after of an audit entry. */
function auditView(r: AgentRow): Record<string, unknown> {
  return {
    name: r.name,
    emoji: r.emoji,
    persona: r.persona,
    model: r.model,
    effort: r.effort,
    approvalPolicy: r.approval_policy,
    desktopPolicy: JSON.parse(r.desktop_policy),
    hostAccess: !!r.host_access,
    budgetDailyUsd: r.budget_daily_usd,
  };
}

export interface Template {
  id: string;
  name: string;
  emoji: string;
  description: string;
  persona: string;
  desktopPolicy: DesktopPolicy;
  approvalPolicy: "auto" | "ask";
  hostAccess: boolean;
}

export const TEMPLATES: Template[] = [
  {
    id: "assistant",
    name: "通用助理",
    emoji: "✨",
    description: "日常问答、写作、整理资料、提醒，偶尔上网查东西",
    persona: "你是用户的私人助理，做事主动、结论先行、回答简洁。遇到需要用户本人决定的事才询问，其余自己查清楚再给结果。",
    desktopPolicy: { desktopIds: [] },
    approvalPolicy: "auto",
    hostAccess: false,
  },
  {
    id: "web",
    name: "网页办事",
    emoji: "🧭",
    description: "在浏览器里替你操作网站：查询、填表、下单前整理信息",
    persona:
      "你擅长在浏览器中完成网页任务。优先用 browser_* 工具按页面结构操作，必要时再用 desktop_* 截图点击。遇到登录、验证码、支付等需要用户本人的步骤，调用 desktop_request_help 请用户接管，不要尝试绕过。",
    desktopPolicy: { desktopIds: [] },
    approvalPolicy: "auto",
    hostAccess: false,
  },
  {
    id: "ops",
    name: "运维",
    emoji: "🛠️",
    description: "管理这台服务器：查看状态、排查故障、改配置（宿主机命令需审批）",
    persona:
      "你是谨慎的运维工程师。先用只读命令了解现状，再给出变更方案；任何修改前先备份。宿主机上的命令通过 host_exec 执行，会经过用户审批，请写清楚每条命令的目的。",
    desktopPolicy: { desktopIds: [] },
    approvalPolicy: "auto",
    hostAccess: true,
  },
  {
    id: "research",
    name: "研究",
    emoji: "🔬",
    description: "多来源查资料、对比、写成带出处的报告",
    persona: "你是研究员。查资料时交叉验证多个来源，结论要注明出处链接；区分事实与推测；最后给出简明结论和可执行建议。",
    desktopPolicy: { desktopIds: [] },
    approvalPolicy: "auto",
    hostAccess: false,
  },
];

export const AgentInput = z.object({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().max(8).optional(),
  template: z.string().default("assistant"),
  persona: z.string().max(4000).optional(),
  model: z.string().min(1).optional(),
  effort: EffortSchema.nullable().optional(),
  approvalPolicy: ApprovalPolicy.optional(),
  /** Instance bindings; old-style policies (e.g. in agent exports) come in unbound. */
  desktopPolicy: z.union([DesktopPolicy, LegacyDesktopPolicy.transform(() => ({ desktopIds: [] }))]).optional(),
  hostAccess: z.boolean().optional(),
  budgetDailyUsd: z.number().positive().nullable().optional(),
});
export type AgentInput = z.infer<typeof AgentInput>;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Agents: configuration, credentials, generated engine config and instructions. */
export class Agents {
  #db: Db;
  #secrets: SecretStore;
  #knowledge: Knowledge;
  #defaultModel: () => string;
  #defaultEffort: () => AgentInput["effort"];

  constructor(deps: { db: Db; secrets: SecretStore; knowledge: Knowledge; defaultModel: () => string; defaultEffort?: () => AgentInput["effort"] }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#knowledge = deps.knowledge;
    this.#defaultModel = deps.defaultModel;
    this.#defaultEffort = deps.defaultEffort ?? (() => null);
  }

  list(includeArchived = false): AgentRow[] {
    return this.#db
      .prepare(`SELECT * FROM agents ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY created_at`)
      .all() as unknown as AgentRow[];
  }

  get(id: string): AgentRow {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    if (!row) throw new Error("agent not found");
    return row;
  }

  byToken(token: string): AgentRow | undefined {
    return this.#db.prepare("SELECT * FROM agents WHERE token_hash = ? AND archived = 0").get(hashToken(token)) as AgentRow | undefined;
  }

  create(input: AgentInput, actor: string): AgentRow {
    const tpl = TEMPLATES.find((t) => t.id === input.template) ?? TEMPLATES[0]!;
    const id = newId("ag").toLowerCase().replace(/_/g, "-");
    const token = randomBytes(24).toString("base64url");
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT INTO agents (id, name, emoji, template, persona, model, effort, approval_policy, desktop_policy, host_access,
          token_hash, budget_daily_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.emoji || tpl.emoji,
        tpl.id,
        input.persona ?? tpl.persona,
        input.model || this.#defaultModel(),
        input.effort === undefined ? (this.#defaultEffort() ?? null) : input.effort,
        input.approvalPolicy ?? tpl.approvalPolicy,
        JSON.stringify(input.desktopPolicy ?? tpl.desktopPolicy),
        (input.hostAccess ?? tpl.hostAccess) ? 1 : 0,
        hashToken(token),
        input.budgetDailyUsd ?? null,
        now,
        now,
      );
    this.#secrets.set(`agent:${id}`, "__token", token);
    this.#knowledge.ensureAgent(id);
    audit(this.#db, actor, "agent.create", { id, name: input.name });
    return this.get(id);
  }

  update(id: string, patch: Partial<AgentInput>, actor: string): AgentRow {
    const cur = this.get(id);
    const p = AgentInput.partial().parse(patch);
    this.#db
      .prepare(
        `UPDATE agents SET name = ?, emoji = ?, persona = ?, model = ?, effort = ?, approval_policy = ?, desktop_policy = ?,
          host_access = ?, budget_daily_usd = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        p.name ?? cur.name,
        p.emoji ?? cur.emoji,
        p.persona ?? cur.persona,
        p.model ?? cur.model,
        p.effort === undefined ? cur.effort : p.effort,
        p.approvalPolicy ?? cur.approval_policy,
        p.desktopPolicy ? JSON.stringify(p.desktopPolicy) : cur.desktop_policy,
        p.hostAccess === undefined ? cur.host_access : p.hostAccess ? 1 : 0,
        p.budgetDailyUsd === undefined ? cur.budget_daily_usd : p.budgetDailyUsd,
        nowIso(),
        id,
      );
    const next = this.get(id);
    audit(this.#db, actor, "agent.update", { id, name: next.name, fields: Object.keys(p), changes: changesOf(auditView(cur), auditView(next), Object.keys(p)) });
    return next;
  }

  archive(id: string, actor: string): void {
    const name = (this.#db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined)?.name;
    this.#db.prepare("UPDATE agents SET archived = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
    audit(this.#db, actor, "agent.archive", { id, name });
  }

  setNewApiToken(id: string, tokenId: number | null, key: string | null): void {
    this.#db.prepare("UPDATE agents SET newapi_token_id = ? WHERE id = ?").run(tokenId, id);
    if (key) this.#secrets.set(`agent:${id}`, "__newapi_key", key);
    else this.#secrets.delete(`agent:${id}`, "__newapi_key");
  }

  token(id: string): string {
    const t = this.#secrets.get(`agent:${id}`, "__token");
    if (!t) throw new Error("agent token missing");
    return t;
  }

  /** User-defined secrets exposed to the agent as environment variables. */
  userSecretNames(id: string): string[] {
    return this.#secrets.names(`agent:${id}`).filter((n) => !n.startsWith("__"));
  }

  setSecret(id: string, name: string, value: string, actor: string): void {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("变量名需为大写字母、数字和下划线");
    this.#secrets.set(`agent:${id}`, name, value);
    audit(this.#db, actor, "agent.secret.set", { id, name });
  }

  deleteSecret(id: string, name: string, actor: string): void {
    this.#secrets.delete(`agent:${id}`, name);
    audit(this.#db, actor, "agent.secret.delete", { id, name });
  }

  /** Environment for the agent container. */
  containerEnv(id: string, globalNewApiKey: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.userSecretNames(id)) env[name] = this.#secrets.get(`agent:${id}`, name)!;
    env.CONSTELLA_AGENT_TOKEN = this.token(id);
    env.NEWAPI_API_KEY = this.#secrets.get(`agent:${id}`, "__newapi_key") ?? globalNewApiKey;
    return env;
  }

  /** Every secret value, for redaction. */
  secretValues(id: string): string[] {
    return Object.values(this.#secrets.all(`agent:${id}`));
  }

  /**
   * Writes ~/.codex/config.toml into the agent's home (owned by the container user). Only the built-in new-api
   * lives here; each run passes its model and provider (with key) when it starts the thread.
   */
  writeEngineConfig(agent: AgentRow, newapiBaseUrl: string, model: string): void {
    const codexHome = path.join(config.agentsDir, agent.id, "home", ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const toml = `# Generated by Constella — edits will be overwritten.
model = ${tomlStr(model)}
model_provider = "newapi"
check_for_update_on_startup = false

[model_providers.newapi]
name = "new-api"
base_url = ${tomlStr(`${newapiBaseUrl}/v1`)}
env_key = "NEWAPI_API_KEY"
wire_api = "responses"
request_max_retries = 4
stream_max_retries = 5

[mcp_servers.constella]
url = ${tomlStr(config.docker.hubMcpUrl)}
bearer_token_env_var = "CONSTELLA_AGENT_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 960

[history]
persistence = "save-all"
`;
    const file = path.join(codexHome, "config.toml");
    fs.writeFileSync(file, toml);
    for (const p of [path.join(config.agentsDir, agent.id, "home"), codexHome, file]) {
      try {
        fs.chownSync(p, 1000, 1000);
      } catch {}
    }
  }

  /** Developer instructions for a new thread: persona, memory, platform rules. */
  instructions(agent: AgentRow, extras: { desktopNote: string; credentialNote?: string; uiNote?: string; styleNote?: string }): string {
    const memory = this.#knowledge.memory(agent.id);
    const secrets = this.userSecretNames(agent.id);
    return [
      `# 你是谁\n你叫「${agent.name}」，是用户 Constella 平台上的一个 agent。\n${agent.persona}`,
      `# 工作环境
- 你运行在自己的 Linux 容器里，工作目录 /workspace（持久保存）。可以自由安装软件、写代码、运行命令。
- 通过 MCP 服务器 constella 提供的工具与平台交互：
  - memory_remember / memory_forget / memory_list：长期记忆。用户说“记住…”或你发现长期有用的事实时调用。
  - notify_user：向用户手机推送通知（任务需要用户知道结果、或定时任务时使用）。
  - schedule_create / schedule_list / schedule_delete：创建定时任务（例如每天提醒）。
  - ask_user：需要主人拍板时，给出 2-4 个选项让主人点选（见下方规则）。
  - get_help：向平台维修员求助。环境出了你自己解决不了的问题时用：它能看到你看不到的实例容器状态和日志，会动手修，并告诉你下一步。
  - send_file：把做好的文件（报告、表格、图片、PDF、压缩包等）发到聊天里交给主人。主人看不到你的容器，产出了主人要拿走的文件就发到聊天里，不要只在回复里写路径。
  - artifact_save / artifact_edit / artifact_read / artifact_list：成果。篇幅较长、主人会反复看或修改的内容（报告、方案、文章、单页网页、脚本、数据表）用 artifact_save 生成成果，主人能直接预览、编辑和下载；之后修改用 artifact_edit（局部）或带 artifact_id 的 artifact_save（整体），每次都会留下新版本。简短的回答直接写在回复里。
  - ${extras.desktopNote}
${extras.credentialNote ? `  - ${extras.credentialNote}\n` : ""}${agent.host_access ? "  - host_exec：在宿主服务器上执行命令。只读命令自动放行，其余需要用户在手机上审批。\n" : ""}- 技能（skills）是以前总结的可复用流程，遇到相关任务先查看再执行。
${secrets.length ? `- 可用的环境变量密钥（只用于调用，不要输出其值）：${secrets.join("、")}\n` : ""}- 自主推进：用户交给你的是目标，你负责探索、执行和验证。能自己查、自己试、自己解决的就直接做；一条路走不通就分析原因换一条，不要停下来问"要不要继续"或把能自己完成的步骤交给用户。
- 一轮只能在任务做完时结束。结束前自查：主人要的结果是否已经做到、交付并验证过。没做完就继续做；需要主人本人做的步骤（登录、验证码、付款）用 desktop_request_help、需要主人拍板的用 ask_user，在这一轮里等，等的时候先做不依赖主人的部分。不要用提问、"要不要继续"、"建议稍后重试"、"下次再…"来结束一轮。平台监督员会复核每一轮的结束，没做完就结束会被发回来接着做。
- 环境出故障（实例没响应、工具一直超时、下载或安装失败、容器异常）不是结束任务的理由。按顺序自救：等一会儿重试 → instance_restart 修实例 → get_help 找维修员 → 换路线（换一台或新建实例、换工具、换做法）。不要以「暂时没成」「建议稍后重试」结束任务；结束前确认主人要的已经做完，或者剩下的确实只有主人本人能做。
- 因为疑惑而停下来代价很大，要尽量避免。只有这些情况才需要主人：会造成不可逆损失的破坏性操作（删除重要数据、清理数据库、改动系统关键配置、强制推送等）；需要主人本人完成的事（登录、验证码、付款）；拿不到、也查不到的信息；真正需要主人拍板的取舍。
- 需要主人拍板时，不要用文字提问后结束，而是调用 ask_user（它会在这一轮里等主人回答）：把问题一次问全，给出 2-4 个具体选项，推荐的放第一个并填 recommended（只在按它继续是安全、可撤销的时候填）。等待期间不要做依赖这个决定的事；主人没回复时按工具返回的指引继续。
- 消息里出现「［监督员］」「［监督员提示］」是平台监督员看到你卡住、或者没做完就结束时给的指示；「［采用方案］」是主人从诊断报告里选的处理方案；「［主人的选择］」是主人对你之前问题的回答。照做并继续推进。
- 默认用简体中文回复，结论先行，简洁直接。完成后给出结果和必要的证据，不要编造。${extras.styleNote ? `\n- ${extras.styleNote}` : ""}`,
      extras.uiNote ?? "",
      memory.user.trim() ? `# 关于用户\n${memory.user.trim()}` : "",
      memory.agent.trim() ? `# 你的记忆\n${memory.agent.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Portable JSON export (no credentials). */
  exportAgent(id: string): unknown {
    const a = this.get(id);
    const memory = this.#knowledge.memory(id);
    const skills = this.#knowledge
      .skills(id)
      .filter((s) => s.scope === "agent")
      .map((s) => ({ name: s.name, content: this.#knowledge.skillBody(id, s.name) }));
    return {
      format: "constella-agent@1",
      exportedAt: nowIso(),
      agent: {
        name: a.name,
        emoji: a.emoji,
        template: a.template,
        persona: a.persona,
        model: a.model,
        effort: a.effort,
        approvalPolicy: a.approval_policy,
        // Instances are local to this hub, so bindings don't travel.
        desktopPolicy: { desktopIds: [] },
        hostAccess: !!a.host_access,
      },
      memory: memory.agent,
      skills,
    };
  }

  importAgent(data: any, actor: string): AgentRow {
    if (data?.format !== "constella-agent@1") throw new Error("不是 Constella agent 导出文件");
    const agent = this.create(AgentInput.parse(data.agent), actor);
    const repo = this.#knowledge.agentRepo(agent.id);
    if (typeof data.memory === "string") fs.writeFileSync(path.join(repo, "MEMORY.md"), data.memory.slice(0, 8000));
    for (const s of Array.isArray(data.skills) ? data.skills.slice(0, 100) : []) {
      if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(s.name)) continue;
      fs.mkdirSync(path.join(repo, "skills", s.name), { recursive: true });
      fs.writeFileSync(path.join(repo, "skills", s.name, "SKILL.md"), String(s.content).slice(0, 20000));
    }
    this.#knowledge.writeMemory(agent.id, "agent", fs.readFileSync(path.join(repo, "MEMORY.md"), "utf8"), "导入");
    return agent;
  }
}

function tomlStr(s: string): string {
  return JSON.stringify(s);
}
