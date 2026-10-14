import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TEXT_ARTIFACT_KINDS, type ArtifactKind } from "@constella/protocol";
import { config, newId, nowIso } from "./config.ts";
import { tx, type Db } from "./db.ts";
import type { EventStore } from "./events.ts";

export interface ArtifactRow {
  id: string;
  agent_id: string;
  /** Where it was first delivered. */
  conversation_id: string | null;
  run_id: string | null;
  title: string;
  /** The latest version's kind, file name, type and size. */
  kind: ArtifactKind;
  language: string | null;
  filename: string;
  mime: string;
  size: number;
  version: number;
  /** Container path the latest version was sent from (send_file); a re-send of it becomes a new version. */
  source_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersionRow {
  artifact_id: string;
  version: number;
  run_id: string | null;
  kind: ArtifactKind;
  language: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  /** What changed in this version, in the author's words. */
  note: string | null;
  author: "agent" | "user";
  source_path: string | null;
  created_at: string;
}

export type ArtifactListItem = ArtifactRow & { agent_name: string | null; agent_emoji: string | null; conversation_title: string | null };

export const MAX_ARTIFACT_FILE = 100 * 1024 * 1024;
/** Largest text artifact written through a tool or the editor, and the most text served for a preview. */
export const MAX_ARTIFACT_TEXT = 2 * 1024 * 1024;

export const isTextKind = (kind: string): boolean => (TEXT_ARTIFACT_KINDS as readonly string[]).includes(kind);

interface TypeInfo {
  kind: ArtifactKind;
  mime: string;
  language?: string;
}

/** Extension → language for code files (also the editor's hint). */
const CODE_EXT: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
  sh: "bash", bash: "bash", zsh: "bash", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", lua: "lua", r: "r",
  sql: "sql", json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", conf: "ini",
  xml: "xml", css: "css", scss: "scss", vue: "vue", dockerfile: "dockerfile", makefile: "makefile",
  diff: "diff", patch: "diff", tex: "latex", ipynb: "json",
};

/** Language → extension, for text artifacts written by the agent. */
const LANG_EXT: Record<string, string> = {
  python: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts", tsx: "tsx", jsx: "jsx", bash: "sh", shell: "sh",
  sh: "sh", go: "go", rust: "rs", java: "java", kotlin: "kt", swift: "swift", c: "c", cpp: "cpp", "c++": "cpp",
  csharp: "cs", ruby: "rb", php: "php", lua: "lua", r: "r", sql: "sql", json: "json", yaml: "yaml", toml: "toml",
  ini: "ini", xml: "xml", css: "css", scss: "scss", vue: "vue", diff: "diff", latex: "tex",
};

const TYPES: Record<string, TypeInfo> = {
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  html: { kind: "html", mime: "text/html" },
  htm: { kind: "html", mime: "text/html" },
  svg: { kind: "svg", mime: "image/svg+xml" },
  csv: { kind: "csv", mime: "text/csv" },
  tsv: { kind: "csv", mime: "text/tab-separated-values" },
  txt: { kind: "text", mime: "text/plain" },
  log: { kind: "text", mime: "text/plain" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  bmp: { kind: "image", mime: "image/bmp" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  flac: { kind: "audio", mime: "audio/flac" },
  aac: { kind: "audio", mime: "audio/aac" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" },
  docx: { kind: "file", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { kind: "file", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { kind: "file", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  doc: { kind: "file", mime: "application/msword" },
  xls: { kind: "file", mime: "application/vnd.ms-excel" },
  ppt: { kind: "file", mime: "application/vnd.ms-powerpoint" },
  zip: { kind: "file", mime: "application/zip" },
  gz: { kind: "file", mime: "application/gzip" },
  tgz: { kind: "file", mime: "application/gzip" },
  tar: { kind: "file", mime: "application/x-tar" },
  "7z": { kind: "file", mime: "application/x-7z-compressed" },
  rar: { kind: "file", mime: "application/vnd.rar" },
  epub: { kind: "file", mime: "application/epub+zip" },
  bz2: { kind: "file", mime: "application/x-bzip2" },
  xz: { kind: "file", mime: "application/x-xz" },
  zst: { kind: "file", mime: "application/zstd" },
  tbz2: { kind: "file", mime: "application/x-bzip2" },
  txz: { kind: "file", mime: "application/x-xz" },
  cab: { kind: "file", mime: "application/vnd.ms-cab-compressed" },
  iso: { kind: "file", mime: "application/x-iso9660-image" },
};

/** Types the browser renders by content: only stored as such when the bytes agree with the extension. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "image/bmp": (b) => b.subarray(0, 2).toString("latin1") === "BM",
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
};

const BINARY: TypeInfo = { kind: "file", mime: "application/octet-stream" };

/** What a file is, from its name and first bytes. */
export function classify(filename: string, head: Buffer): TypeInfo {
  const lower = filename.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  const known: TypeInfo | undefined =
    TYPES[ext] ?? (CODE_EXT[ext] ? { kind: "code", mime: ext === "json" ? "application/json" : "text/plain", language: CODE_EXT[ext] } : undefined);
  if (known) {
    const magic = MAGIC[known.mime];
    if (magic && !magic(head)) return BINARY;
    if (isTextKind(known.kind) && !looksLikeText(head)) return BINARY;
    return known;
  }
  for (const [mime, test] of Object.entries(MAGIC)) if (test(head)) return { kind: mime === "application/pdf" ? "pdf" : "image", mime };
  return looksLikeText(head) ? { kind: "text", mime: "text/plain" } : BINARY;
}

function looksLikeText(head: Buffer): boolean {
  if (head.includes(0)) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // The sample may end in the middle of a multi-byte character.
  for (let cut = 0; cut <= Math.min(3, head.length); cut++) {
    try {
      decoder.decode(head.subarray(0, head.length - cut));
      return true;
    } catch {}
  }
  return false;
}

/** A file name safe to store and send back in Content-Disposition. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return clean.slice(-120) || "file";
}

/** File name for a text artifact: the title, with the extension its kind / language calls for. */
export function textFilename(title: string, kind: ArtifactKind, language?: string | null): string {
  const ext = kind === "code" ? (LANG_EXT[(language ?? "").toLowerCase()] ?? "txt") : ({ markdown: "md", html: "html", svg: "svg", csv: "csv" } as Record<string, string>)[kind] ?? "txt";
  const stem = title.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "artifact";
  return `${stem}.${ext}`;
}

function textMime(kind: ArtifactKind, language?: string | null): string {
  if (kind === "code") return (language ?? "").toLowerCase() === "json" ? "application/json" : "text/plain";
  return ({ markdown: "text/markdown", html: "text/html", svg: "image/svg+xml", csv: "text/csv" } as Record<string, string>)[kind] ?? "text/plain";
}

/**
 * Apply exact find-and-replace edits in order. Each `old` must occur exactly once, so an edit can't land
 * somewhere the agent didn't mean (e.g. after the owner changed the text).
 */
export function applyEdits(text: string, edits: { old: string; new: string }[]): string {
  let out = text;
  edits.forEach((e, i) => {
    const at = out.indexOf(e.old);
    if (at < 0) throw new Error(`第 ${i + 1} 处修改：最新版本里没有找到这段原文（主人可能改过），先用 artifact_read 读最新内容`);
    if (out.indexOf(e.old, at + 1) >= 0) throw new Error(`第 ${i + 1} 处修改：这段原文出现了不止一次，多带一些上下文让它唯一`);
    out = out.slice(0, at) + e.new + out.slice(at + e.old.length);
  });
  return out;
}

const OUTSIDE = "只能用 /workspace 或 /home/agent 下的路径（相对路径按 /workspace 算）；/tmp 等其他目录不在共享存储里，先复制到 /workspace";

/** Where a file was saved, in the agent's container and on this host. */
interface AgentFile {
  container: string;
  host: string;
}

/**
 * Files and documents agents delivered, with every version kept. Files live under the artifacts directory
 * (never mounted into an agent), one per version; agents reach them only through the MCP tools.
 */
export class Artifacts {
  #db: Db;
  #events: EventStore;
  #dir: string;
  #agentsDir: string;

  constructor(deps: { db: Db; events: EventStore; dir?: string; agentsDir?: string }) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#dir = deps.dir ?? config.artifactsDir;
    this.#agentsDir = deps.agentsDir ?? config.agentsDir;
  }

  get dir(): string {
    return this.#dir;
  }

  get(id: string): ArtifactRow | undefined {
    return this.#db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  }

  /** One of the agent's own artifacts; anything else reads as "not found" to the agent. */
  owned(agentId: string, id: string): ArtifactRow {
    const a = this.get(id.trim());
    if (!a || a.agent_id !== agentId) throw new Error(`找不到成果 ${id}；用 artifact_list 查看你的成果`);
    return a;
  }

  versions(id: string): ArtifactVersionRow[] {
    return this.#db.prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC").all(id) as unknown as ArtifactVersionRow[];
  }

  /** A version of an artifact; the latest when `version` is left out. */
  version(id: string, version?: number): ArtifactVersionRow {
    const row = (
      version === undefined
        ? this.#db.prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1").get(id)
        : this.#db.prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?").get(id, version)
    ) as ArtifactVersionRow | undefined;
    if (!row) throw new Error(version === undefined ? "成果不存在" : `没有第 ${version} 版`);
    return row;
  }

  filePath(id: string, version: number): string {
    return path.join(this.#dir, id, String(version));
  }

  /** One artifact with its agent and conversation names, as the list shows it. */
  item(id: string): ArtifactListItem | undefined {
    return this.list({ id, limit: 1 })[0];
  }

  list(filter: { id?: string; agentId?: string; conversationId?: string; kinds?: string[]; q?: string; limit?: number } = {}): ArtifactListItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.id) {
      where.push("a.id = ?");
      args.push(filter.id);
    }
    if (filter.agentId) {
      where.push("a.agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter.conversationId) {
      // Born in this conversation, or given a new version in it.
      where.push("(a.conversation_id = ? OR a.id IN (SELECT v.artifact_id FROM artifact_versions v JOIN runs r ON r.id = v.run_id WHERE r.conversation_id = ?))");
      args.push(filter.conversationId, filter.conversationId);
    }
    if (filter.kinds?.length) {
      where.push(`a.kind IN (${filter.kinds.map(() => "?").join(",")})`);
      args.push(...filter.kinds);
    }
    if (filter.q?.trim()) {
      const like = `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(a.title LIKE ? ESCAPE '\\' OR a.filename LIKE ? ESCAPE '\\')");
      args.push(like, like);
    }
    args.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    return this.#db
      .prepare(
        `SELECT a.*, ag.name AS agent_name, ag.emoji AS agent_emoji, c.title AS conversation_title
         FROM artifacts a LEFT JOIN agents ag ON ag.id = a.agent_id LEFT JOIN conversations c ON c.id = a.conversation_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.updated_at DESC LIMIT ?`,
      )
      .all(...args) as unknown as ArtifactListItem[];
  }

  /** A text artifact's content (the latest version unless asked for another), cut at `max` bytes. */
  text(id: string, version?: number, max = MAX_ARTIFACT_TEXT): { text: string; version: ArtifactVersionRow; truncated: boolean } {
    const v = this.version(id, version);
    if (!isTextKind(v.kind)) throw new Error("这一版不是文本，不能按文本读取");
    const fd = fs.openSync(this.filePath(id, v.version), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, max));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: new TextDecoder("utf-8").decode(buf), version: v, truncated: size > max };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Map a path in the agent's container to this host, inside its own workspace or home. */
  agentPath(agentId: string, p: string): AgentFile {
    let s = p.trim();
    if (s === "~" || s.startsWith("~/")) s = `/home/agent${s.slice(1)}`;
    const abs = path.posix.isAbsolute(s) ? path.posix.normalize(s) : path.posix.join("/workspace", s);
    for (const [prefix, dir] of [
      ["/workspace", "workspace"],
      ["/home/agent", "home"],
    ] as const) {
      if (abs === prefix || abs.startsWith(`${prefix}/`)) return { container: abs, host: path.join(this.#agentsDir, agentId, dir, abs.slice(prefix.length)) };
    }
    throw new Error(OUTSIDE);
  }

  /** The real (symlink-free) directories an agent's files may be read from or written to. */
  #roots(agentId: string): string[] {
    return ["workspace", "home"].flatMap((d) => {
      try {
        return [fs.realpathSync(path.join(this.#agentsDir, agentId, d))];
      } catch {
        return [];
      }
    });
  }

  /**
   * Open one of the agent's files for reading. The check runs on what was actually opened (/proc/self/fd),
   * so a symlink, or a path swapped after the check, can't make the hub read something outside the agent's
   * own directories (the database, other agents' files).
   */
  #openAgentFile(agentId: string, file: AgentFile): { fd: number; size: number } {
    let fd: number;
    try {
      fd = fs.openSync(file.host, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw new Error(`找不到文件 ${file.container}`);
      if (err?.code === "EACCES") throw new Error(`没有权限读取 ${file.container}`);
      throw err;
    }
    try {
      if (!inside(openedPath(fd, file.host), this.#roots(agentId))) throw new Error(`${file.container} 指向了你的工作目录以外的位置，不能发送`);
      const st = fs.fstatSync(fd);
      if (st.isDirectory()) throw new Error(`${file.container} 是一个目录；先打包成 zip 或 tar.gz 再发送`);
      if (!st.isFile()) throw new Error(`${file.container} 不是普通文件`);
      if (st.size > MAX_ARTIFACT_FILE) throw new Error(`文件太大（${mb(st.size)}），最大 ${mb(MAX_ARTIFACT_FILE)}；压缩或拆分后再发送`);
      return { fd, size: st.size };
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  /**
   * A file from the agent's container becomes an artifact: a new one, or the next version of `artifactId`.
   * Re-sending the same path under the same title in the same conversation also makes a new version.
   */
  async fromFile(input: {
    agentId: string;
    runId: string | null;
    conversationId: string | null;
    path: string;
    title?: string;
    note?: string;
    artifactId?: string;
  }): Promise<ArtifactRow> {
    const target = input.artifactId ? this.owned(input.agentId, input.artifactId) : undefined;
    const file = this.agentPath(input.agentId, input.path);
    const { fd } = this.#openAgentFile(input.agentId, file);
    let tmp = "";
    try {
      const head = Buffer.alloc(8192);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      const filename = safeFilename(path.posix.basename(file.container));
      const type = classify(filename, head.subarray(0, n));
      const title = (input.title?.trim() || filename).slice(0, 120);
      const existing =
        target ??
        (this.#db
          .prepare("SELECT * FROM artifacts WHERE agent_id = ? AND conversation_id IS ? AND source_path = ? AND title = ? ORDER BY updated_at DESC LIMIT 1")
          .get(input.agentId, input.conversationId, file.container, title) as ArtifactRow | undefined);
      tmp = this.#tmp(existing?.id);
      const { sha256, size } = await copyFd(fd, tmp);
      return this.#commit({ existing, agentId: input.agentId, runId: input.runId, conversationId: input.conversationId, title, type, filename, size, sha256, note: input.note, author: "agent", sourcePath: file.container, tmp });
    } catch (err) {
      if (tmp) fs.rmSync(tmp, { force: true });
      throw err;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  /** Create a text artifact, or replace the text of an existing one (as its next version). */
  saveText(input: {
    agentId: string;
    runId: string | null;
    conversationId: string | null;
    artifactId?: string;
    title?: string;
    kind?: ArtifactKind;
    language?: string | null;
    content: string;
    note?: string | null;
    author: "agent" | "user";
  }): ArtifactRow {
    const existing = input.artifactId ? (input.author === "agent" ? this.owned(input.agentId, input.artifactId) : this.get(input.artifactId)) : undefined;
    if (input.artifactId && !existing) throw new Error("成果不存在");
    const kind = input.kind ?? existing?.kind ?? "text";
    if (!isTextKind(kind)) {
      throw new Error(existing && !input.kind ? "这个成果是文件，不能用文本覆盖；重新用 send_file 发送新版本" : "只有文档、网页、代码、SVG、CSV、文本类成果可以直接写入内容");
    }
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > MAX_ARTIFACT_TEXT) throw new Error(`内容太长（${mb(bytes.length)}），最大 ${mb(MAX_ARTIFACT_TEXT)}`);
    const title = (input.title?.trim() || existing?.title || "未命名").slice(0, 120);
    const language = kind === "code" ? (input.language ?? existing?.language ?? null) : null;
    // Keep the file name when only the text changes; derive a new one when the title or type changes.
    const filename = existing && existing.kind === kind && existing.title === title && existing.language === language ? existing.filename : textFilename(title, kind, language);
    const tmp = this.#tmp(existing?.id);
    fs.writeFileSync(tmp, bytes, { flag: "wx" });
    try {
      return this.#commit({
        existing,
        agentId: existing?.agent_id ?? input.agentId,
        runId: input.runId,
        conversationId: input.conversationId,
        title,
        type: { kind, mime: textMime(kind, language), language: language ?? undefined },
        filename,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        note: input.note,
        author: input.author,
        sourcePath: null,
        tmp,
      });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Replace the bytes of an existing file artifact (an edited Word / Excel / PowerPoint file) as its next version. */
  saveFile(input: { artifactId: string; bytes: Buffer; note?: string | null; author: "agent" | "user" }): ArtifactRow {
    const existing = this.get(input.artifactId);
    if (!existing) throw new Error("成果不存在");
    if (input.bytes.length > MAX_ARTIFACT_FILE) throw new Error(`文件太大（${mb(input.bytes.length)}），最大 ${mb(MAX_ARTIFACT_FILE)}`);
    const tmp = this.#tmp(existing.id);
    fs.writeFileSync(tmp, input.bytes, { flag: "wx" });
    try {
      return this.#commit({
        existing,
        agentId: existing.agent_id,
        runId: null,
        conversationId: null,
        title: existing.title,
        type: { kind: existing.kind, mime: existing.mime, language: existing.language ?? undefined },
        filename: existing.filename,
        size: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        note: input.note,
        author: input.author,
        sourcePath: null,
        tmp,
      });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Apply find-and-replace edits to the latest text of one of the agent's artifacts. */
  edit(input: { agentId: string; artifactId: string; edits: { old: string; new: string }[]; note?: string; runId: string | null; conversationId: string | null }): ArtifactRow {
    const a = this.owned(input.agentId, input.artifactId);
    if (!isTextKind(a.kind)) throw new Error("这个成果是文件，不能按文本修改；重新用 send_file 发送新版本");
    const { text, truncated } = this.text(a.id);
    if (truncated) throw new Error("内容太长，不能按片段修改");
    return this.saveText({ agentId: input.agentId, runId: input.runId, conversationId: input.conversationId, artifactId: a.id, content: applyEdits(text, input.edits), note: input.note, author: "agent" });
  }

  /** Bring back an older version, as the newest one. */
  restore(id: string, version: number): ArtifactRow {
    const a = this.get(id);
    if (!a) throw new Error("成果不存在");
    const v = this.version(id, version);
    const tmp = this.#tmp(id);
    fs.copyFileSync(this.filePath(id, v.version), tmp, fs.constants.COPYFILE_EXCL);
    return this.#commit({
      existing: a,
      agentId: a.agent_id,
      runId: null,
      conversationId: null,
      title: a.title,
      type: { kind: v.kind, mime: v.mime, language: v.language ?? undefined },
      filename: v.filename,
      size: v.size,
      sha256: v.sha256,
      note: `恢复到第 ${v.version} 版`,
      author: "user",
      sourcePath: v.source_path,
      tmp,
    });
  }

  rename(id: string, title: string): ArtifactRow {
    const t = title.trim().slice(0, 120);
    if (!t) throw new Error("标题不能为空");
    if (this.#db.prepare("UPDATE artifacts SET title = ? WHERE id = ?").run(t, id).changes !== 1) throw new Error("成果不存在");
    const a = this.get(id)!;
    this.#events.publish("artifact", { id, agentId: a.agent_id, conversationId: a.conversation_id });
    return a;
  }

  remove(id: string): void {
    const a = this.get(id);
    if (!a) return;
    tx(this.#db, () => {
      this.#db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ?").run(id);
      this.#db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    });
    fs.rmSync(path.join(this.#dir, id), { recursive: true, force: true });
    this.#events.publish("artifact", { id, agentId: a.agent_id, conversationId: a.conversation_id, removed: true });
  }

  /**
   * Copy a version into the agent's container (artifact_read save_to). The parent directory is opened first
   * and checked, and the file is created through that handle without following a symlink, so the write
   * can't be redirected outside the agent's own directories.
   */
  exportTo(agentId: string, id: string, version: number | undefined, target: string): { container: string; size: number } {
    const a = this.owned(agentId, id);
    const v = this.version(a.id, version);
    const file = this.agentPath(agentId, target);
    const name = path.posix.basename(file.container);
    if (!name || name === "." || name === ".." || file.container === "/workspace" || file.container === "/home/agent") throw new Error("save_to 要写到具体的文件名，例如 /workspace/report.pdf");
    let dirFd: number;
    try {
      dirFd = fs.openSync(path.dirname(file.host), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    } catch {
      throw new Error(`目录 ${path.posix.dirname(file.container)} 不存在，先创建它`);
    }
    try {
      if (!inside(openedPath(dirFd, path.dirname(file.host)), this.#roots(agentId))) throw new Error(`${path.posix.dirname(file.container)} 指向了你的工作目录以外的位置`);
      let out: number;
      try {
        out = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
      } catch (err: any) {
        if (err?.code === "ELOOP") throw new Error(`${file.container} 是符号链接，换一个文件名`);
        throw err;
      }
      try {
        const data = fs.readFileSync(this.filePath(a.id, v.version));
        fs.writeSync(out, data);
        try {
          fs.fchownSync(out, 1000, 1000);
        } catch {}
        return { container: file.container, size: data.length };
      } finally {
        fs.closeSync(out);
      }
    } finally {
      fs.closeSync(dirFd);
    }
  }

  #tmp(id?: string): string {
    const dir = path.join(this.#dir, id ?? ".incoming");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  }

  /** Store the version written to `tmp` and point the artifact at it; returns the artifact as it is now. */
  #commit(input: {
    existing?: ArtifactRow;
    agentId: string;
    runId: string | null;
    conversationId: string | null;
    title: string;
    type: TypeInfo;
    filename: string;
    size: number;
    sha256: string;
    note?: string | null;
    author: "agent" | "user";
    sourcePath: string | null;
    tmp: string;
  }): ArtifactRow {
    const id = input.existing?.id ?? newId("art");
    const now = nowIso();
    const note = input.note?.trim().slice(0, 300) || null;
    tx(this.#db, () => {
      const current = input.existing ? (this.#db.prepare("SELECT version FROM artifacts WHERE id = ?").get(id) as { version: number } | undefined) : undefined;
      if (input.existing && !current) throw new Error("成果已被删除");
      const version = (current?.version ?? 0) + 1;
      fs.mkdirSync(path.join(this.#dir, id), { recursive: true });
      fs.renameSync(input.tmp, this.filePath(id, version));
      if (input.existing) {
        this.#db
          .prepare(
            "UPDATE artifacts SET title = ?, kind = ?, language = ?, filename = ?, mime = ?, size = ?, version = ?, source_path = ?, run_id = COALESCE(?, run_id), updated_at = ? WHERE id = ?",
          )
          .run(input.title, input.type.kind, input.type.language ?? null, input.filename, input.type.mime, input.size, version, input.sourcePath, input.runId, now, id);
      } else {
        this.#db
          .prepare(
            `INSERT INTO artifacts (id, agent_id, conversation_id, run_id, title, kind, language, filename, mime, size, version, source_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.agentId, input.conversationId, input.runId, input.title, input.type.kind, input.type.language ?? null, input.filename, input.type.mime, input.size, version, input.sourcePath, now, now);
      }
      this.#db
        .prepare(
          "INSERT INTO artifact_versions (artifact_id, version, run_id, kind, language, filename, mime, size, sha256, note, author, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, version, input.runId, input.type.kind, input.type.language ?? null, input.filename, input.type.mime, input.size, input.sha256, note, input.author, input.sourcePath, now);
    });
    const a = this.get(id)!;
    this.#events.publish("artifact", { id, agentId: a.agent_id, conversationId: a.conversation_id, version: a.version });
    return a;
  }
}

/** The path of what a file descriptor actually points at (falls back to resolving the name). */
function openedPath(fd: number, fallback: string): string {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return fs.realpathSync(fallback);
  }
}

function inside(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r + path.sep));
}

async function copyFd(fd: number, dest: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    fs.createReadStream("", { fd, autoClose: false, start: 0 }),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_ARTIFACT_FILE) return cb(new Error(`文件太大，最大 ${mb(MAX_ARTIFACT_FILE)}`));
        hash.update(chunk);
        cb(null, chunk);
      },
    }),
    fs.createWriteStream(dest, { flags: "wx" }),
  );
  return { sha256: hash.digest("hex"), size };
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
