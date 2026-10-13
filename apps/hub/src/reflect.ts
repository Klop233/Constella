import { z } from "zod";
import { config, nowIso } from "./config.ts";
import { kvGet, kvSet, type Db } from "./db.ts";
import type { NewApi } from "./newapi.ts";

/** "Reflect": activity stats over a period plus a model-written look back at what the conversations were about. */

export interface ReflectStats {
  days: number;
  conversations: number;
  runs: number;
  minutes: number;
  /** 0 = Sunday … 6 = Saturday, in the hub's timezone; null without activity. */
  topWeekday: number | null;
  topHour: number | null;
  series: { day: string; conversations: number; runs: number; minutes: number }[];
}

interface RunLite {
  conversation_id: string;
  created_at: string;
  finished_at: string | null;
}

function parts(iso: string, tz: string): { day: string; weekday: number; hour: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!), hour: Number(p.hour) };
}

const argmax = (counts: number[]): number | null => {
  let best = -1;
  for (let i = 0; i < counts.length; i++) if (counts[i]! > 0 && (best < 0 || counts[i]! > counts[best]!)) best = i;
  return best < 0 ? null : best;
};

export function reflectStats(runs: RunLite[], days: number, now = new Date(), tz = config.timezone): ReflectStats {
  const series = new Map<string, { conversations: Set<string>; runs: number; minutes: number }>();
  for (let i = days - 1; i >= 0; i--) series.set(parts(new Date(now.getTime() - i * 86_400_000).toISOString(), tz).day, { conversations: new Set(), runs: 0, minutes: 0 });
  const weekdays = new Array(7).fill(0);
  const hours = new Array(24).fill(0);
  const convs = new Set<string>();
  let minutes = 0;
  let count = 0;
  for (const r of runs) {
    const { day, weekday, hour } = parts(r.created_at, tz);
    const bucket = series.get(day);
    if (!bucket) continue;
    const m = r.finished_at ? Math.max(0, (Date.parse(r.finished_at) - Date.parse(r.created_at)) / 60_000) : 0;
    bucket.conversations.add(r.conversation_id);
    bucket.runs++;
    bucket.minutes += m;
    weekdays[weekday]++;
    hours[hour]++;
    convs.add(r.conversation_id);
    minutes += m;
    count++;
  }
  return {
    days,
    conversations: convs.size,
    runs: count,
    minutes: Math.round(minutes),
    topWeekday: argmax(weekdays),
    topHour: argmax(hours),
    series: [...series].map(([day, b]) => ({ day, conversations: b.conversations.size, runs: b.runs, minutes: Math.round(b.minutes) })),
  };
}

const Summary = z.object({ headline: z.string().min(1).max(80), body: z.string().min(1).max(800) });
export type ReflectSummary = z.infer<typeof Summary> & { generatedAt: string; model: string };

const SYSTEM = `你在帮用户回顾他们最近和自己的 agent 们的对话。根据给出的对话列表（标题、所属 agent、日期、用户的开场请求），写一段简短的回顾。
要求：
- 用第二人称"你"，简体中文，语气温和、具体，像朋友帮你总结这段时间在忙什么。
- headline：一句话点出这段时间的主线，不超过 24 个字，例如"这个月，agent 们主要在帮你盯服务器"。
- body：2～4 句。先说集中在哪些主题、哪几天，再说你使用 agent 的方式或习惯（比如先问一个具体问题再追问、常让它定时提醒）。只根据给出的内容，不要编造。
- 只输出 JSON：{"headline": "...", "body": "..."}`;

export class Reflect {
  private d: { db: Db; newapi: NewApi; model: () => string };

  constructor(d: { db: Db; newapi: NewApi; model: () => string }) {
    this.d = d;
  }

  #runsSince(days: number): (RunLite & { agent: string; title: string; prompt: string })[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.d.db
      .prepare(
        `SELECT r.conversation_id, r.created_at, r.finished_at, r.prompt, c.title, a.name AS agent
         FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN agents a ON a.id = r.agent_id
         WHERE r.created_at >= ? ORDER BY r.created_at`,
      )
      .all(since) as any[];
  }

  stats(days: number): ReflectStats {
    return reflectStats(this.#runsSince(days), days);
  }

  cached(days: number): ReflectSummary | null {
    const raw = kvGet(this.d.db, `reflect.${days}`);
    return raw ? (JSON.parse(raw) as ReflectSummary) : null;
  }

  async summarize(days: number): Promise<ReflectSummary | null> {
    const runs = this.#runsSince(days);
    if (!runs.length) return null;
    // One line per conversation: its first request is the best signal of what it was about.
    const seen = new Map<string, string>();
    for (const r of runs) {
      if (seen.has(r.conversation_id)) continue;
      seen.set(r.conversation_id, `- ${parts(r.created_at, config.timezone).day} [${r.agent}] ${r.title}：${r.prompt.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    const list = [...seen.values()].slice(-120).join("\n");
    const model = this.d.model();
    const raw = await this.d.newapi.chatJson(model, SYSTEM, `时间范围：最近 ${days} 天，共 ${seen.size} 个对话、${runs.length} 次任务。\n\n${list}`);
    const parsed = Summary.safeParse(raw);
    if (!parsed.success) throw new Error("模型返回的回顾格式不对，请重试");
    const out: ReflectSummary = { ...parsed.data, generatedAt: nowIso(), model };
    kvSet(this.d.db, `reflect.${days}`, JSON.stringify(out));
    return out;
  }
}
