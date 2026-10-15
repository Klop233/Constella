import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, newId, nowIso } from "./config.ts";
import type { Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import { redact } from "./secrets.ts";

/**
 * Engine-agnostic knowledge: plain Markdown memory and Agent Skills (SKILL.md) in git repos.
 *   agent repo:  <agents>/<id>/home/knowledge/{MEMORY.md, skills/<name>/SKILL.md}
 *   shared repo: <data>/shared/{USER.md, skills/<name>/SKILL.md}
 * Every change is a commit, so the app can show diffs and revert any learning step.
 */

export const MEMORY_LIMIT = 4000;
export const USER_LIMIT = 3000;
const SKILL_LIMIT = 8000;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

export const KnowledgeOps = z.object({
  memory: z
    .array(
      z.object({
        op: z.enum(["add", "update", "delete"]),
        scope: z.enum(["agent", "user"]).default("agent"),
        text: z.string().max(300).default(""),
        match: z.string().max(200).optional(),
      }),
    )
    .max(8)
    .default([]),
  skills: z
    .array(
      z.object({
        op: z.enum(["create", "patch"]),
        name: z.string().regex(SKILL_NAME),
        description: z.string().min(5).max(300),
        body: z.string().min(20).max(SKILL_LIMIT),
      }),
    )
    .max(3)
    .default([]),
  promote: z.array(z.string().regex(SKILL_NAME)).max(3).default([]),
});
export type KnowledgeOps = z.infer<typeof KnowledgeOps>;

export interface SkillInfo {
  name: string;
  description: string;
  scope: "agent" | "shared";
  uses: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface LearningEvent {
  id: string;
  agent_id: string | null;
  scope: string;
  kind: string;
  op: string;
  target: string;
  summary: string;
  commit_sha: string;
  run_id: string | null;
  reverted: number;
  created_at: string;
}

const GIT_ID = ["-c", "safe.directory=*", "-c", "user.name=Constella", "-c", "user.email=constella@localhost", "-c", "commit.gpgsign=false"];

function git(repo: string, args: string[]): string {
  return execFileSync("git", [...GIT_ID, "-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export class Knowledge {
  #db: Db;
  #events: EventStore;
  /** Values that must never be written into knowledge (API keys etc.). */
  #secretValues: () => string[];

  constructor(db: Db, events: EventStore, secretValues: () => string[]) {
    this.#db = db;
    this.#events = events;
    this.#secretValues = secretValues;
  }

  agentRepo(agentId: string): string {
    return path.join(config.agentsDir, agentId, "home", "knowledge");
  }

  sharedRepo(): string {
    return path.join(config.dataDir, "shared");
  }

  initRepo(dir: string, files: Record<string, string>): void {
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    if (!fs.existsSync(path.join(dir, ".git"))) {
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      for (const [name, content] of Object.entries(files)) {
        const f = path.join(dir, name);
        if (!fs.existsSync(f)) fs.writeFileSync(f, content);
      }
      fs.writeFileSync(path.join(dir, "skills", ".gitkeep"), "");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "init"]);
    }
  }

  ensureShared(): void {
    this.initRepo(this.sharedRepo(), { "USER.md": "# 用户画像\n\n" });
  }

  ensureAgent(agentId: string): void {
    this.initRepo(this.agentRepo(agentId), { "MEMORY.md": "# 记忆\n\n" });
  }

  memory(agentId: string): { agent: string; user: string } {
    return {
      agent: readOr(path.join(this.agentRepo(agentId), "MEMORY.md"), ""),
      user: readOr(path.join(this.sharedRepo(), "USER.md"), ""),
    };
  }

  /** Replace a memory file wholesale (manual edit from the app). */
  writeMemory(agentId: string, scope: "agent" | "user", content: string, actor: string): LearningEvent | null {
    const limit = scope === "agent" ? MEMORY_LIMIT : USER_LIMIT;
    if (content.length > limit * 1.5) throw new Error(`内容过长（上限约 ${limit} 字）`);
    const { repo, file } = this.#memoryFile(agentId, scope);
    fs.writeFileSync(file, this.#redact(content));
    return this.#commit(repo, `${actor} 编辑${scope === "agent" ? "记忆" : "用户画像"}`, {
      agentId: scope === "agent" ? agentId : null,
      scope: scope === "agent" ? "agent" : "shared",
      kind: "memory",
      op: "update",
      target: path.basename(file),
      runId: null,
    });
  }

  /**
   * Apply validated ops (from reflection, curation or the memory tools) and commit each
   * logical change separately so it can be reverted on its own.
   */
  apply(agentId: string, rawOps: unknown, source: { runId: string | null; reason: string }): LearningEvent[] {
    const ops = KnowledgeOps.parse(rawOps);
    const out: LearningEvent[] = [];
    for (const m of ops.memory) {
      const { repo, file } = this.#memoryFile(agentId, m.scope);
      const limit = m.scope === "agent" ? MEMORY_LIMIT : USER_LIMIT;
      const text = this.#redact(m.text.replace(/\s+/g, " ").trim());
      const { header, items: current } = parseMemory(readOr(file, ""));
      let items = current;
      const matchIdx = m.match ? items.findIndex((i) => i.includes(m.match!)) : -1;
      let summary = "";
      if (m.op === "add") {
        if (!text || items.some((i) => similar(i, text))) continue;
        items.push(text);
        summary = `记住：${text}`;
      } else if (m.op === "update") {
        if (matchIdx < 0 || !text) continue;
        summary = `更新：${items[matchIdx]} → ${text}`;
        items[matchIdx] = text;
      } else {
        if (matchIdx < 0) continue;
        summary = `忘记：${items[matchIdx]}`;
        items = items.filter((_, i) => i !== matchIdx);
      }
      const content = renderMemory(header, items);
      if (content.length > limit) {
        summary = "";
        continue; // over budget: curator will consolidate first
      }
      fs.writeFileSync(file, content);
      const ev = this.#commit(repo, summary, {
        agentId: m.scope === "agent" ? agentId : null,
        scope: m.scope === "agent" ? "agent" : "shared",
        kind: "memory",
        op: m.op,
        target: path.basename(file),
        runId: source.runId,
      });
      if (ev) out.push(ev);
    }
    for (const s of ops.skills) {
      const repo = this.agentRepo(agentId);
      const dir = path.join(repo, "skills", s.name);
      const exists = fs.existsSync(path.join(dir, "SKILL.md"));
      if (s.op === "patch" && !exists) continue;
      if (s.op === "create" && exists) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), skillFile(s.name, s.description, this.#redact(s.body)));
      const ev = this.#commit(repo, `${s.op === "create" ? "新技能" : "改进技能"}：${s.name} — ${s.description}`, {
        agentId,
        scope: "agent",
        kind: "skill",
        op: s.op,
        target: s.name,
        runId: source.runId,
      });
      if (ev) out.push(ev);
    }
    for (const name of ops.promote) {
      const ev = this.promote(agentId, name, source.runId);
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * Dry run of an import: what would happen to each candidate fact if it were added now.
   * Import only ever adds — nothing already remembered is changed — and the same checks run again on
   * `importMemory`, so a plan shown to the user and the write that follows can't disagree.
   */
  planImport(agentId: string, candidates: ImportCandidate[]): ImportPlanItem[] {
    const state = {
      user: this.#importState(agentId, "user"),
      agent: this.#importState(agentId, "agent"),
    };
    return candidates.map((c) => {
      const scope = c.scope;
      const plain = c.text.replace(/\s+/g, " ").trim();
      const text = this.#redact(plain);
      const unsafe = text !== plain ? "含密钥" : unsafeImportReason(text);
      if (unsafe) return { scope, text, status: "unsafe", reason: unsafe };
      const s = state[scope];
      if (s.items.some((i) => similar(i, text))) return { scope, text, status: "duplicate" };
      if (renderMemory(s.header, [...s.items, text]).length > s.limit) return { scope, text, status: "capacity" };
      s.items.push(text);
      return { scope, text, status: "new" };
    });
  }

  /** Add the importable facts, one commit per memory file (so a whole import reverts in one click). */
  importMemory(agentId: string, candidates: ImportCandidate[], actor: string): { plan: ImportPlanItem[]; events: LearningEvent[] } {
    const plan = this.planImport(agentId, candidates);
    const events: LearningEvent[] = [];
    for (const scope of ["user", "agent"] as const) {
      const fresh = plan.filter((p) => p.scope === scope && p.status === "new");
      if (!fresh.length) continue;
      const { repo, file } = this.#memoryFile(agentId, scope);
      const { header, items } = parseMemory(readOr(file, ""));
      fs.writeFileSync(file, renderMemory(header, [...items, ...fresh.map((f) => f.text)]));
      const ev = this.#commit(repo, `${actor}导入 ${fresh.length} 条${scope === "agent" ? "记忆" : "用户画像"}`, {
        agentId: scope === "agent" ? agentId : null,
        scope: scope === "agent" ? "agent" : "shared",
        kind: "memory",
        op: "add",
        target: path.basename(file),
        runId: null,
      });
      if (ev) events.push(ev);
    }
    return { plan, events };
  }

  /** How much of each memory file is used, for the import preview. */
  memoryBudget(agentId: string): { user: { used: number; limit: number }; agent: { used: number; limit: number } } {
    const m = this.memory(agentId);
    return { user: { used: m.user.length, limit: USER_LIMIT }, agent: { used: m.agent.length, limit: MEMORY_LIMIT } };
  }

  #importState(agentId: string, scope: "agent" | "user"): { header: string[]; items: string[]; limit: number } {
    const { header, items } = parseMemory(readOr(this.#memoryFile(agentId, scope).file, ""));
    return { header, items, limit: scope === "agent" ? MEMORY_LIMIT : USER_LIMIT };
  }

  /** Copy an agent skill into the shared library so every agent gets it. */
  promote(agentId: string, name: string, runId: string | null = null): LearningEvent | null {
    const src = path.join(this.agentRepo(agentId), "skills", name, "SKILL.md");
    if (!SKILL_NAME.test(name) || !fs.existsSync(src)) return null;
    const dir = path.join(this.sharedRepo(), "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, "SKILL.md"));
    return this.#commit(this.sharedRepo(), `共享技能：${name}`, {
      agentId,
      scope: "shared",
      kind: "skill",
      op: "create",
      target: name,
      runId,
    });
  }

  deleteSkill(agentId: string | null, name: string, actor: string): LearningEvent | null {
    if (!SKILL_NAME.test(name)) throw new Error("invalid skill name");
    const repo = agentId ? this.agentRepo(agentId) : this.sharedRepo();
    const dir = path.join(repo, "skills", name);
    if (!fs.existsSync(dir)) throw new Error("skill not found");
    fs.rmSync(dir, { recursive: true, force: true });
    return this.#commit(repo, `${actor} 删除技能：${name}`, {
      agentId,
      scope: agentId ? "agent" : "shared",
      kind: "skill",
      op: "delete",
      target: name,
      runId: null,
    });
  }

  skills(agentId: string): SkillInfo[] {
    const usage = new Map(
      (this.#db.prepare("SELECT skill, uses, last_used_at FROM skill_usage WHERE agent_id = ?").all(agentId) as any[]).map((r) => [
        r.skill,
        r,
      ]),
    );
    const read = (repo: string, scope: "agent" | "shared"): SkillInfo[] => {
      const root = path.join(repo, "skills");
      if (!fs.existsSync(root)) return [];
      return fs
        .readdirSync(root)
        .filter((n) => fs.existsSync(path.join(root, n, "SKILL.md")))
        .map((n) => {
          const file = path.join(root, n, "SKILL.md");
          const meta = parseFrontmatter(fs.readFileSync(file, "utf8"));
          const u = usage.get(n);
          return {
            name: n,
            description: meta.description ?? "",
            scope,
            uses: u?.uses ?? 0,
            lastUsedAt: u?.last_used_at ?? null,
            updatedAt: fs.statSync(file).mtime.toISOString(),
          };
        });
    };
    return [...read(this.agentRepo(agentId), "agent"), ...read(this.sharedRepo(), "shared")];
  }

  skillBody(agentId: string | null, name: string): string {
    if (!SKILL_NAME.test(name)) throw new Error("invalid skill name");
    for (const repo of agentId ? [this.agentRepo(agentId), this.sharedRepo()] : [this.sharedRepo()]) {
      const f = path.join(repo, "skills", name, "SKILL.md");
      if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
    }
    throw new Error("skill not found");
  }

  /** Record that a run used skills (detected from the engine reading SKILL.md files). */
  recordSkillUse(agentId: string, names: string[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO skill_usage (agent_id, skill, uses, last_used_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(agent_id, skill) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`,
    );
    for (const n of new Set(names)) stmt.run(agentId, n, nowIso());
  }

  events(filter: { agentId?: string; limit?: number }): LearningEvent[] {
    const limit = filter.limit ?? 100;
    if (filter.agentId) {
      return this.#db
        .prepare("SELECT * FROM learning_events WHERE agent_id = ? OR (agent_id IS NULL) ORDER BY created_at DESC LIMIT ?")
        .all(filter.agentId, limit) as unknown as LearningEvent[];
    }
    return this.#db.prepare("SELECT * FROM learning_events ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as LearningEvent[];
  }

  diff(eventId: string): string {
    const ev = this.#event(eventId);
    return git(this.#repoFor(ev), ["show", "--no-color", "--format=%s%n", ev.commit_sha]);
  }

  revert(eventId: string, actor: string): void {
    const ev = this.#event(eventId);
    if (ev.reverted) throw new Error("已撤销");
    const repo = this.#repoFor(ev);
    try {
      git(repo, ["revert", "--no-edit", ev.commit_sha]);
    } catch (err) {
      try {
        git(repo, ["revert", "--abort"]);
      } catch {}
      throw new Error(`无法自动撤销（后续修改与之冲突）：${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
    this.#db.prepare("UPDATE learning_events SET reverted = 1 WHERE id = ?").run(eventId);
    this.#events.publish("learning.reverted", { id: eventId, actor });
  }

  #event(id: string): LearningEvent {
    const ev = this.#db.prepare("SELECT * FROM learning_events WHERE id = ?").get(id) as LearningEvent | undefined;
    if (!ev) throw new Error("learning event not found");
    return ev;
  }

  #repoFor(ev: LearningEvent): string {
    return ev.scope === "shared" ? this.sharedRepo() : this.agentRepo(ev.agent_id!);
  }

  #memoryFile(agentId: string, scope: "agent" | "user"): { repo: string; file: string } {
    return scope === "agent"
      ? { repo: this.agentRepo(agentId), file: path.join(this.agentRepo(agentId), "MEMORY.md") }
      : { repo: this.sharedRepo(), file: path.join(this.sharedRepo(), "USER.md") };
  }

  #redact(text: string): string {
    // Common key shapes even if we don't know the value.
    return redact(text, this.#secretValues()).replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,})\b/g, "«secret»");
  }

  #commit(
    repo: string,
    summary: string,
    meta: { agentId: string | null; scope: "agent" | "shared"; kind: string; op: string; target: string; runId: string | null },
  ): LearningEvent | null {
    git(repo, ["add", "-A"]);
    if (!git(repo, ["status", "--porcelain"])) return null;
    git(repo, ["commit", "-q", "-m", summary.slice(0, 200)]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    const ev: LearningEvent = {
      id: newId("le"),
      agent_id: meta.agentId,
      scope: meta.scope,
      kind: meta.kind,
      op: meta.op,
      target: meta.target,
      summary: summary.slice(0, 300),
      commit_sha: sha,
      run_id: meta.runId,
      reverted: 0,
      created_at: nowIso(),
    };
    this.#db
      .prepare(
        `INSERT INTO learning_events (id, agent_id, scope, kind, op, target, summary, commit_sha, run_id, reverted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(ev.id, ev.agent_id, ev.scope, ev.kind, ev.op, ev.target, ev.summary, ev.commit_sha, ev.run_id, ev.created_at);
    this.#events.publish("learning", ev);
    return ev;
  }
}

function readOr(file: string, fallback: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function trimTrailing(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

/** A memory file is a header (title, anything not a bullet) followed by one fact per "- " line. */
function parseMemory(content: string): { header: string[]; items: string[] } {
  const lines = content.split("\n");
  return { header: lines.filter((l) => !l.startsWith("- ")), items: lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2)) };
}

function renderMemory(header: string[], items: string[]): string {
  return [...trimTrailing(header), "", ...items.map((i) => `- ${i}`), ""].join("\n");
}

/** A fact someone else's export wants us to remember. */
export interface ImportCandidate {
  scope: "agent" | "user";
  text: string;
}

export interface ImportPlanItem extends ImportCandidate {
  /** new: will be added · duplicate: already remembered · capacity: memory file is full · unsafe: held back by a safety check */
  status: "new" | "duplicate" | "capacity" | "unsafe";
  reason?: string;
}

/** Longest single fact accepted from an import — longer is prose, not a fact. */
export const IMPORT_ITEM_MAX = 200;

const INJECTION =
  /ignore (all |any |the )?(previous|prior|above|earlier|preceding) (instructions?|rules?|prompts?|messages?)|disregard (all |any |the )?(previous|prior|above|your) |(reveal|show|print) (your |the )?system prompt|jailbreak|(忽略|无视|不要遵守|不再遵守).{0,8}(指令|规则|提示词?|设定|限制)|越狱|你现在(是|扮演)|泄露.{0,6}(系统提示|提示词)/i;

/**
 * Deterministic backstop behind the model's own filtering: things that must never become long-term memory
 * no matter how the export is worded (it is injected into every prompt of every agent from then on).
 */
export function unsafeImportReason(text: string): string | null {
  if (!text) return "空内容";
  if (text.length > IMPORT_ITEM_MAX) return "太长，不像一条事实";
  if (INJECTION.test(text)) return "像是给 AI 的指令";
  if (/\d{9,}/.test(text) || /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{2,4}\b/.test(text)) return "含长数字（疑似证件、账号或电话）";
  return null;
}

function similar(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[\s，。,.!！?？:：;；"'“”‘’]/g, "");
  const x = n(a);
  const y = n(b);
  return x === y || (x.length > 8 && y.includes(x)) || (y.length > 8 && x.includes(y));
}

export function skillFile(name: string, description: string, body: string): string {
  const desc = description.replace(/\n/g, " ").replace(/"/g, "'");
  const content = body.replace(/^---[\s\S]*?---\s*/, "").trim();
  return `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${content}\n`;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
