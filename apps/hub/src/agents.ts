import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DesktopPolicy, ApprovalPolicy } from "@constella/protocol";
import { z } from "zod";
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
    desktopPolicy: { mode: "on_demand" },
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
    desktopPolicy: { mode: "on_demand" },
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
    desktopPolicy: { mode: "none" },
    approvalPolicy: "auto",
    hostAccess: true,
  },
  {
    id: "research",
    name: "研究",
    emoji: "🔬",
    description: "多来源查资料、对比、写成带出处的报告",
    persona: "你是研究员。查资料时交叉验证多个来源，结论要注明出处链接；区分事实与推测；最后给出简明结论和可执行建议。",
    desktopPolicy: { mode: "on_demand" },
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
  effort: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
  approvalPolicy: ApprovalPolicy.optional(),
  desktopPolicy: DesktopPolicy.optional(),
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

  constructor(deps: { db: Db; secrets: SecretStore; knowledge: Knowledge; defaultModel: () => string }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#knowledge = deps.knowledge;
    this.#defaultModel = deps.defaultModel;
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
        input.effort ?? null,
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
    audit(this.#db, actor, "agent.update", { id, fields: Object.keys(p) });
    return this.get(id);
  }

  archive(id: string, actor: string): void {
    this.#db.prepare("UPDATE agents SET archived = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
    audit(this.#db, actor, "agent.archive", { id });
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

  /** Writes ~/.codex/config.toml into the agent's home (owned by the container user). */
  writeEngineConfig(agent: AgentRow, newapiBaseUrl: string): void {
    const codexHome = path.join(config.agentsDir, agent.id, "home", ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const toml = `# Generated by Constella — edits will be overwritten.
model = ${tomlStr(agent.model)}
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
  instructions(agent: AgentRow, extras: { desktopNote: string }): string {
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
  - ${extras.desktopNote}
${agent.host_access ? "  - host_exec：在宿主服务器上执行命令。只读命令自动放行，其余需要用户在手机上审批。\n" : ""}- 技能（skills）是以前总结的可复用流程，遇到相关任务先查看再执行。
${secrets.length ? `- 可用的环境变量密钥（只用于调用，不要输出其值）：${secrets.join("、")}\n` : ""}- 自主推进：用户交给你的是目标，你负责探索、执行和验证。能自己查、自己试、自己解决的就直接做；一条路走不通就分析原因换一条，不要停下来问"要不要继续"或把能自己完成的步骤交给用户。
- 只在这些情况停下来问用户：会造成不可逆损失的破坏性操作（删除重要数据、清理数据库、改动系统关键配置、强制推送等）；需要用户本人完成的事（登录、验证码、付款）；拿不到、也查不到的信息；真正需要用户拍板的取舍。需要问时把问题一次问全。
- 默认用简体中文回复，结论先行，简洁直接。完成后给出结果和必要的证据，不要编造。`,
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
        desktopPolicy: JSON.parse(a.desktop_policy).mode === "fixed" ? { mode: "on_demand" } : JSON.parse(a.desktop_policy),
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
