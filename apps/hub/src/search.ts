import type { Db } from "./db.ts";

export interface SearchHit {
  conversationId: string;
  title: string;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  archived: boolean;
  updatedAt: string;
  /** Where it matched: the title, something you wrote, or an agent reply. */
  where: "title" | "you" | "agent";
  /** A short piece of text around the match. */
  snippet: string;
}

const LIMIT = 30;

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** About `width` characters around the first match, on one line. */
export function snippetOf(text: string, q: string, width = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor((width - q.length) / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Conversations whose title, your messages or the agents' replies contain `q` (case-insensitive), most recently
 * active first, one hit per conversation.
 */
export function searchConversations(db: Db, query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const like = `%${escapeLike(q)}%`;
  const lower = q.toLowerCase();
  const found = new Map<string, { where: SearchHit["where"]; text: string; at: string }>();
  const add = (conversationId: string, where: SearchHit["where"], text: string, at: string) => {
    if (!text.toLowerCase().includes(lower)) return;
    const cur = found.get(conversationId);
    if (!cur || (cur.where !== "title" && at > cur.at)) found.set(conversationId, { where, text, at });
  };

  for (const r of db.prepare("SELECT id, title, updated_at FROM conversations WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 200").all(like) as {
    id: string;
    title: string;
    updated_at: string;
  }[]) {
    found.set(r.id, { where: "title", text: r.title, at: r.updated_at });
  }
  for (const r of db.prepare("SELECT conversation_id, prompt, created_at FROM runs WHERE prompt LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 300").all(like) as {
    conversation_id: string;
    prompt: string;
    created_at: string;
  }[]) {
    add(r.conversation_id, "you", r.prompt, r.created_at);
  }
  // Replies are stored as JSON; the LIKE narrows, the parsed text decides.
  for (const r of db
    .prepare(
      `SELECT r.conversation_id, e.data, e.ts FROM events e JOIN runs r ON r.id = e.run_id
       WHERE e.type = 'message.completed' AND e.data LIKE ? ESCAPE '\\' ORDER BY e.ts DESC LIMIT 300`,
    )
    .all(like) as { conversation_id: string; data: string; ts: string }[]) {
    let text = "";
    try {
      text = String((JSON.parse(r.data) as { text?: unknown }).text ?? "");
    } catch {
      continue;
    }
    add(r.conversation_id, "agent", text, r.ts);
  }
  if (!found.size) return [];

  const ids = [...found.keys()];
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.agent_id, c.archived_at, c.updated_at, a.name AS agent_name, a.emoji AS agent_emoji
       FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as { id: string; title: string; agent_id: string; archived_at: string | null; updated_at: string; agent_name: string | null; agent_emoji: string | null }[];
  return rows
    .map((c) => {
      const hit = found.get(c.id)!;
      return {
        conversationId: c.id,
        title: c.title,
        agentId: c.agent_id,
        agentName: c.agent_name ?? "已删除的 agent",
        agentEmoji: c.agent_emoji ?? "✨",
        archived: !!c.archived_at,
        updatedAt: c.updated_at,
        where: hit.where,
        snippet: snippetOf(hit.text, q),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, LIMIT);
}
