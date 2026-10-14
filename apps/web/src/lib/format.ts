import type { RunStatus } from "./types";

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("zh-CN", today ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const STATUS_TEXT: Record<RunStatus, string> = {
  queued: "排队中",
  running: "进行中",
  waiting_approval: "等你处理",
  paused_by_user: "你在操作桌面",
  done: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export function statusTone(s: RunStatus | null | undefined): "ok" | "warn" | "danger" | "accent" | "muted" {
  if (!s) return "muted";
  if (s === "running" || s === "queued") return "accent";
  if (s === "waiting_approval" || s === "paused_by_user") return "warn";
  if (s === "failed") return "danger";
  if (s === "done") return "ok";
  return "muted";
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const CRON_HINTS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(\d+) (\d+) \* \* \*$/, (m) => `每天 ${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`],
  [/^(\d+) (\d+) \* \* 1-5$/, (m) => `工作日 ${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`],
  [/^(\d+) (\d+) \* \* (\d)$/, (m) => `每周${"日一二三四五六"[Number(m[3]) % 7]} ${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`],
  [/^\*\/(\d+) \* \* \* \*$/, (m) => `每 ${m[1]} 分钟`],
  [/^0 \*\/(\d+) \* \* \*$/, (m) => `每 ${m[1]} 小时`],
];

export function describeCron(cron: string): string {
  for (const [re, fn] of CRON_HINTS) {
    const m = re.exec(cron.trim());
    if (m) return fn(m);
  }
  return cron;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

export const fmtMinutes = (m: number) => (m % 60 === 0 && m >= 60 ? `${m / 60} 小时` : `${m} 分钟`);

/** Single-turn time limits the hub accepts; 0 is no limit. */
export const RUN_TIMEOUTS = [0, 30, 60, 120, 240, 480];
export const runTimeoutLabel = (m: number) => (m === 0 ? "不限制" : fmtMinutes(m));
