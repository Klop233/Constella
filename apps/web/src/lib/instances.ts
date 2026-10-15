import { Globe, Monitor, Smartphone, type LucideIcon } from "lucide-react";
import type { Agent, Desktop, DesktopKind, IdleAction, InstanceOp } from "./types";

export const KINDS: DesktopKind[] = ["browser", "desktop", "android"];

export const KIND_INFO: Record<DesktopKind, { label: string; icon: LucideIcon; hint: string }> = {
  browser: { label: "浏览器", icon: Globe, hint: "只有一个浏览器，最省资源（约 0.3–1 GB）" },
  desktop: { label: "Linux 桌面", icon: Monitor, hint: "完整桌面，能装和运行其他程序（约 0.4–1.5 GB）" },
  android: { label: "安卓", icon: Smartphone, hint: "安卓系统，能装 App（约 2–4 GB）" },
};

export const IDLE_LABEL: Record<IdleAction | "default", string> = { default: "跟随设置", pause: "暂停", stop: "停止", none: "一直运行" };

/** Screen size presets per kind (Android also sets the density). */
export const SIZE_PRESETS: Record<DesktopKind, { label: string; width: number; height: number; dpi?: number }[]> = {
  browser: [
    { label: "1280×800", width: 1280, height: 800 },
    { label: "1440×900", width: 1440, height: 900 },
    { label: "1920×1080", width: 1920, height: 1080 },
  ],
  desktop: [
    { label: "1280×800", width: 1280, height: 800 },
    { label: "1440×900", width: 1440, height: 900 },
    { label: "1920×1080", width: 1920, height: 1080 },
  ],
  android: [
    { label: "720×1280", width: 720, height: 1280, dpi: 320 },
    { label: "1080×1920", width: 1080, height: 1920, dpi: 480 },
    { label: "平板 1280×800", width: 1280, height: 800, dpi: 213 },
  ],
};

/** What an operation under way is called, in progressive form. */
export const OP_LABEL: Record<InstanceOp, string> = {
  starting: "启动中",
  stopping: "停止中",
  restarting: "重启中",
  pausing: "暂停中",
  repairing: "修复中",
  resetting: "重建中",
};

/** The operation as a plain noun-verb, for "…没有成功". */
export const OP_NAME: Record<InstanceOp, string> = {
  starting: "启动",
  stopping: "停止",
  restarting: "重启",
  pausing: "暂停",
  repairing: "修复",
  resetting: "清空重建",
};

/** Who is on an instance, or what state it is in, for its status line (a `StatusDot` tone). An operation under way and a failure come first. */
export function leaseText(d: Desktop, agents: Agent[] | undefined): { text: string; tone: "ok" | "warn" | "busy" | "off" | "danger" } {
  if (d.op) return { text: OP_LABEL[d.op], tone: "busy" };
  if (d.error) return { text: "出错了", tone: "danger" };
  const l = d.leaseInfo;
  if (l.holder === "human") return { text: "你在操作", tone: "warn" };
  if (l.holder === "agent") {
    const a = agents?.find((x) => x.id === l.agentId);
    return { text: `${a ? `${a.emoji} ${a.name}` : "agent"} 使用中`, tone: "busy" };
  }
  if (d.state === "running") return { text: "空闲", tone: "ok" };
  if (d.state === "paused") return { text: "已暂停", tone: "off" };
  if (d.state === "starting") return { text: "启动中", tone: "off" };
  return { text: "已停止", tone: "off" };
}

export type InstanceGroup = "running" | "paused" | "stopped" | "error";

export const GROUP_LABEL: Record<InstanceGroup, string> = { running: "运行中", paused: "已暂停", stopped: "已停止", error: "出错" };

/** Which tab an instance is under: a failed operation or a broken container is 出错, a starting one counts as running. */
export function groupOf(d: Desktop): InstanceGroup {
  if (d.error || d.state === "error") return "error";
  if (d.state === "running" || d.state === "starting" || d.op === "starting") return "running";
  if (d.state === "paused") return "paused";
  return "stopped";
}

export type InstanceSort = "recent" | "name" | "memory" | "created";

export const SORT_OPTIONS: { value: InstanceSort; label: string }[] = [
  { value: "recent", label: "最近使用" },
  { value: "name", label: "名称" },
  { value: "memory", label: "内存占用" },
  { value: "created", label: "创建时间" },
];

/** Whether the search text is in the instance's name, its kind or the name of an agent it is given to. */
export function matchesQuery(d: Desktop, query: string, agents: Agent[] | undefined): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const users = (agents ?? []).filter((a) => d.agentIds.includes(a.id)).map((a) => a.name);
  return [d.name, KIND_INFO[d.kind].label, d.kind, ...users].some((t) => t.toLowerCase().includes(q));
}

/** A sorted copy. `memory` is the container memory in bytes by instance id (instances that aren't running count as 0). */
export function sortInstances(list: Desktop[], sort: InstanceSort, memory: (id: string) => number): Desktop[] {
  const by: Record<InstanceSort, (a: Desktop, b: Desktop) => number> = {
    recent: (a, b) => b.last_used_at.localeCompare(a.last_used_at),
    name: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
    memory: (a, b) => memory(b.id) - memory(a.id),
    created: (a, b) => b.created_at.localeCompare(a.created_at),
  };
  return [...list].sort((a, b) => by[sort](a, b) || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** Whether a thumbnail (live, or the last frame kept when paused / stopped) may exist. */
export function hasThumbnail(d: Desktop): boolean {
  return d.state !== "missing" && d.state !== "error";
}
