import { z } from "zod";
import type { AgentEvent } from "@constella/protocol";
import { config } from "./config.ts";
import type { Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import { KnowledgeOps, MEMORY_LIMIT, type Knowledge, type LearningEvent } from "./knowledge.ts";
import type { ModelRegistry } from "./models.ts";
import type { RunRow } from "./runs.ts";

const REFLECT_SYSTEM = `你是一个 AI 助手团队的"复盘员"。你会读到某个 agent 刚完成的一次任务记录，判断其中有没有值得长期保存的知识。
只输出一个 JSON 对象，格式：
{
  "memory": [{"op":"add|update|delete","scope":"agent|user","text":"…","match":"更新/删除时用于定位原条目的片段"}],
  "skills": [{"op":"create|patch","name":"kebab-case 英文名","description":"一句话说明何时使用","body":"Markdown 步骤说明"}],
  "promote": ["值得共享给所有 agent 的技能名"]
}
规则：
- memory 只记长期有用、可复用的事实：用户偏好、环境信息（路径、账号名、服务地址）、踩过的坑。scope=user 用于关于用户本人的信息，scope=agent 用于该 agent 的工作经验。每条不超过 100 字，用中文。
- 不要记录一次性的任务内容、临时数据、密码/密钥/令牌。
- skills 只在任务包含至少 3 个有实际难度的步骤、过程中有非显而易见的做法或踩坑、并且这次成功了时才创建；简单的一两步操作（打开网页看标题、执行一条命令）不要创建技能。已有同类技能时用 patch 改进它（name 必须与已有技能一致）。body 写清楚步骤、命令、注意事项，不超过 60 行。
- promote 只能填“已有技能”里标注使用次数 ≥ 2 次、且对其他 agent 也通用的技能。
- 用户点了"踩"（失败/不满意）时，重点记录原因和下次应如何避免。
- 没有值得保存的内容就返回 {"memory":[],"skills":[],"promote":[]}。宁缺毋滥。`;

const CURATE_SYSTEM = `你是知识库整理员。下面是某个 agent 的记忆文件和技能列表。请输出 JSON：
{"memory":[{"op":"update|delete","scope":"agent","text":"…","match":"…"}],"skills":[],"promote":[]}
目标：合并重复条目、删除过时或矛盾的条目、把记忆压缩到 ${MEMORY_LIMIT} 字以内。不要新增事实。没有需要整理的就返回空数组。`;

const INSTRUCT_SYSTEM = `你在帮用户直接修改 agent 的长期记忆。你会看到两份记忆（每行一条）和用户的修改要求。
只输出一个 JSON 对象：
{"reply":"一句话告诉用户你做了什么（或为什么没改）","memory":[{"op":"add|update|delete","scope":"agent|user","text":"新内容","match":"更新/删除时用于定位原条目的原文片段"}]}
规则：
- scope=user 是关于用户本人的信息（所有 agent 共享），scope=agent 是这个 agent 自己的工作经验。
- update / delete 的 match 必须是原条目里连续出现的原文片段。
- 每条不超过 100 字，用中文；不要写入密码、密钥、令牌。
- 用户的要求含糊或和记忆无关时，memory 返回空数组，在 reply 里说明。`;

const Instruct = z.object({ reply: z.string().min(1).max(300), memory: KnowledgeOps.shape.memory });

/** Turns finished runs into memory/skill updates (post-run reflection) and keeps knowledge tidy (curation). */
export class Learning {
  #db: Db;
  #events: EventStore;
  #knowledge: Knowledge;
  #llm: Pick<ModelRegistry, "chatJson">;
  #model: () => string;
  #auto: () => { enabled: boolean; minToolCalls: number };
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: {
    db: Db;
    events: EventStore;
    knowledge: Knowledge;
    llm: Pick<ModelRegistry, "chatJson">;
    model: () => string;
    /** Reflect on finished runs by themselves, and from how many tool calls on (👍 / 👎 always triggers it). */
    auto?: () => { enabled: boolean; minToolCalls: number };
  }) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#knowledge = deps.knowledge;
    this.#llm = deps.llm;
    this.#model = deps.model;
    this.#auto = deps.auto ?? (() => ({ enabled: true, minToolCalls: 3 }));
  }

  /** Hook for RunManager.onFinished; feedback can also trigger it later. */
  maybeReflect(run: RunRow): void {
    if (run.reflected) return;
    const auto = this.#auto();
    const worth = run.feedback !== null || (auto.enabled && run.status === "done" && run.tool_calls >= auto.minToolCalls);
    if (!worth || run.status === "cancelled") return;
    this.#queue = this.#queue.then(() => this.reflect(run.id).then(() => undefined)).catch((err) => {
      console.error("reflection failed", err);
    });
  }

  async reflect(runId: string): Promise<LearningEvent[]> {
    const run = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!run || run.reflected) return [];
    this.#db.prepare("UPDATE runs SET reflected = 1 WHERE id = ?").run(runId);
    const transcript = transcriptFor(run, this.#events.forRun(runId));
    const skillList = this.#knowledge.skills(run.agent_id);
    const skills = skillList.map((s) => `- ${s.name}（${s.scope === "shared" ? "共享" : "自有"}，已使用 ${s.uses} 次）：${s.description}`);
    const memory = this.#knowledge.memory(run.agent_id);
    const user = [
      `## 已有记忆\n${memory.agent.slice(0, MEMORY_LIMIT)}`,
      `## 用户画像\n${memory.user.slice(0, 2000)}`,
      `## 已有技能\n${skills.join("\n") || "（无）"}`,
      `## 本次任务（状态：${run.status}${run.feedback === 1 ? "，用户点赞" : run.feedback === -1 ? "，用户点踩" : ""}）\n${transcript}`,
    ].join("\n\n");
    const raw = await this.#llm.chatJson(this.#model(), REFLECT_SYSTEM, user);
    const parsed = KnowledgeOps.safeParse(raw);
    if (!parsed.success) {
      console.error("reflection output rejected", parsed.error.issues.slice(0, 3));
      return [];
    }
    // Only skills that proved themselves get shared with every agent.
    const proven = new Set(skillList.filter((s) => s.scope === "agent" && s.uses >= 2).map((s) => s.name));
    const ops = { ...parsed.data, promote: parsed.data.promote.filter((n) => proven.has(n)) };
    return this.#knowledge.apply(run.agent_id, ops, { runId, reason: "reflection" });
  }

  /** Apply a change the user described in words ("记住我不喝咖啡", "删掉关于旧服务器的那条"). */
  async instruct(agentId: string, request: string): Promise<{ reply: string; events: LearningEvent[] }> {
    const memory = this.#knowledge.memory(agentId);
    const user = [
      `## 关于用户（所有 agent 共享）\n${memory.user.trim() || "（空）"}`,
      `## 这个 agent 的记忆\n${memory.agent.trim() || "（空）"}`,
      `## 用户的要求\n${request}`,
    ].join("\n\n");
    const parsed = Instruct.safeParse(await this.#llm.chatJson(this.#model(), INSTRUCT_SYSTEM, user));
    if (!parsed.success) throw new Error("没理解这个要求，换个说法再试试");
    const events = parsed.data.memory.length
      ? this.#knowledge.apply(agentId, { memory: parsed.data.memory, skills: [], promote: [] }, { runId: null, reason: "用户要求" })
      : [];
    return { reply: events.length || !parsed.data.memory.length ? parsed.data.reply : "没有找到要改的那条记忆，换个说法再试试", events };
  }

  async curate(agentId: string): Promise<LearningEvent[]> {
    const memory = this.#knowledge.memory(agentId);
    const skills = this.#knowledge.skills(agentId).filter((s) => s.scope === "agent");
    const user = `## 记忆\n${memory.agent}\n\n## 技能（名称 / 说明 / 使用次数）\n${skills
      .map((s) => `- ${s.name} / ${s.description} / ${s.uses}`)
      .join("\n")}`;
    const raw = await this.#llm.chatJson(this.#model(), CURATE_SYSTEM, user);
    const parsed = KnowledgeOps.safeParse(raw);
    const out = parsed.success ? this.#knowledge.apply(agentId, { ...parsed.data, skills: [], promote: [] }, { runId: null, reason: "curate" }) : [];
    // Retire agent skills nobody used for 60 days (and older than 60 days).
    const cutoff = Date.now() - 60 * 86_400_000;
    for (const s of skills) {
      const last = s.lastUsedAt ? Date.parse(s.lastUsedAt) : Date.parse(s.updatedAt);
      if (s.uses === 0 && last < cutoff) {
        const ev = this.#knowledge.deleteSkill(agentId, s.name, "整理");
        if (ev) out.push(ev);
      }
    }
    return out;
  }

  async curateAll(): Promise<void> {
    const agents = this.#db.prepare("SELECT id FROM agents WHERE archived = 0").all() as { id: string }[];
    for (const { id } of agents) {
      try {
        await this.curate(id);
      } catch (err) {
        console.error(`curate ${id} failed`, err);
      }
    }
  }
}

/** Compact, model-friendly summary of a run's events (bounded size). */
export function transcriptFor(run: Pick<RunRow, "prompt" | "status" | "error">, events: AgentEvent[]): string {
  const lines: string[] = [`用户：${run.prompt.slice(0, 2000)}`];
  const tools = new Map<string, string>();
  for (const ev of events) {
    switch (ev.type) {
      case "tool.started":
        tools.set(ev.callId, `${ev.name} ${JSON.stringify(ev.input ?? {}).slice(0, 300)}`);
        break;
      case "tool.completed":
        lines.push(`工具：${tools.get(ev.callId) ?? ev.callId} → ${ev.ok ? "成功" : `失败${ev.error ? `：${ev.error.slice(0, 200)}` : ""}`}`);
        break;
      case "message.completed":
        lines.push(`助手：${ev.text.slice(0, 1500)}`);
        break;
      case "approval.resolved":
        lines.push(`审批：${ev.decision === "approve" ? "批准" : "拒绝"}`);
        break;
    }
  }
  if (run.error) lines.push(`错误：${run.error.slice(0, 500)}`);
  const text = lines.join("\n");
  return text.length > 12000 ? `${text.slice(0, 6000)}\n…（中间省略）…\n${text.slice(-6000)}` : text;
}

export function defaultReflectModel(db: Db): string {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'settings.reflectModel'").get() as { value: string } | undefined;
  return row?.value || config.reflectModel;
}
