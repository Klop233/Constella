import type { AgentEvent } from "@constella/protocol";

/**
 * What fills a conversation's context window. The engine only reports totals, so the parts are
 * estimated from text and calibrated against measurements: the first request of a thread is
 * exactly "system prompt + tool definitions + first message", and the latest request's
 * contextTokens is the current total.
 */

/** Rough token count: CJK characters ≈ 1 token each, everything else ≈ 4 characters per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[　-鿿가-힯＀-￯]/g)?.length ?? 0;
  return Math.round(cjk + (text.length - cjk) / 4);
}

export interface ContextPart {
  key: "persona" | "memory" | "skills" | "builtin" | "messages" | "tools";
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  used: number;
  window: number | null;
  parts: ContextPart[];
  /** False when no request of this thread has reported its size yet. */
  measured: boolean;
}

export function contextBreakdown(input: {
  persona: string;
  memory: string;
  skills: string;
  runs: { prompt: string; events: AgentEvent[] }[];
}): ContextBreakdown | null {
  const usage = input.runs.flatMap((r) => r.events).filter((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage" && e.durationMs !== 0);
  const latest = usage.findLast((e) => e.contextTokens != null);
  if (!latest) return null;
  const used = latest.contextTokens!;

  const persona = estimateTokens(input.persona);
  const memory = estimateTokens(input.memory);
  const skills = estimateTokens(input.skills);
  // Fixed part of every request: measured from the thread's first request, minus the first message.
  const first = usage[0]!;
  let fixed = Math.max(persona + memory + skills, first.inputTokens - estimateTokens(input.runs[0]?.prompt ?? ""));
  let builtin = Math.max(0, fixed - persona - memory - skills);
  const scale = fixed > used ? used / fixed : 1; // after a compaction the fixed part can't exceed the total
  const [p, m, s, b] = [persona, memory, skills, builtin].map((x) => Math.round(x * scale)) as [number, number, number, number];
  fixed = p + m + s + b;
  builtin = b;

  // The rest is the conversation itself, split by how much text messages vs tool traffic carried.
  let msgText = 0;
  let toolText = 0;
  for (const r of input.runs) {
    msgText += estimateTokens(r.prompt);
    for (const e of r.events) {
      if (e.type === "message.completed") msgText += estimateTokens(e.text);
      else if (e.type === "tool.started") toolText += estimateTokens(JSON.stringify(e.input ?? ""));
      else if (e.type === "tool.output") toolText += estimateTokens(e.chunk);
      else if (e.type === "tool.completed" && e.result != null) toolText += estimateTokens(JSON.stringify(e.result));
    }
  }
  const convo = Math.max(0, used - fixed);
  const toolShare = msgText + toolText ? toolText / (msgText + toolText) : 0;
  const tools = Math.round(convo * toolShare);

  return {
    used,
    window: latest.contextWindow ?? null,
    measured: true,
    parts: [
      { key: "persona", label: "人设与工作说明", tokens: p },
      { key: "memory", label: "记忆", tokens: m },
      { key: "skills", label: "技能目录", tokens: s },
      { key: "builtin", label: "Codex 内置提示与工具定义", tokens: builtin },
      { key: "messages", label: "消息", tokens: convo - tools },
      { key: "tools", label: "工具调用与结果", tokens: tools },
    ],
  };
}
