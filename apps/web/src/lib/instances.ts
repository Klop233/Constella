import { Globe, Monitor, Smartphone, type LucideIcon } from "lucide-react";
import type { Agent, Desktop, DesktopKind, IdleAction } from "./types";

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

/** Who is on an instance, or what state it is in, for badges. */
export function leaseText(d: Desktop, agents: Agent[] | undefined): { text: string; tone: "ok" | "warn" | "accent" | "muted" } {
  const l = d.leaseInfo;
  if (l.holder === "human") return { text: "你在操作", tone: "warn" };
  if (l.holder === "agent") {
    const a = agents?.find((x) => x.id === l.agentId);
    return { text: `${a ? `${a.emoji} ${a.name}` : "agent"} 使用中`, tone: "accent" };
  }
  if (d.state === "running") return { text: "空闲", tone: "ok" };
  if (d.state === "paused") return { text: "已暂停", tone: "muted" };
  if (d.state === "starting") return { text: "启动中", tone: "muted" };
  return { text: "已停止", tone: "muted" };
}

/** Whether a thumbnail (live, or the last frame kept when paused / stopped) may exist. */
export function hasThumbnail(d: Desktop): boolean {
  return d.state !== "missing" && d.state !== "error";
}
