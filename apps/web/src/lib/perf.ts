/** Performance samples from /api/perf (see apps/hub/src/perf.ts). */

export type PerfRange = "1h" | "24h";

/** cpu: host = busy share 0–1, container = cores; mem in bytes; rx/tx in bytes per second. */
export interface PerfPoint {
  t: number;
  cpu: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
}

export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  cpuModel: string;
  cores: number;
  memTotal: number | null;
  swapTotal: number | null;
  disk: { path: string; total: number } | null;
  scope: "host" | "cgroup" | "container";
  network: boolean;
  dockerVersion: string;
}

export interface HostNow {
  cpu: number | null;
  mem: number | null;
  memCache: number | null;
  swap: number | null;
  load: [number, number, number];
  uptimeS: number;
  diskUsed: number | null;
  rx: number | null;
  tx: number | null;
}

export interface PerfContainer {
  name: string;
  role: string;
  agentId: string | null;
  desktopId: string | null;
  running: boolean;
  memLimit: number | null;
  pids: number | null;
  now: PerfPoint | null;
}

export interface PerfGroup {
  type: "instance" | "agent" | "system";
  id: string;
  name: string;
  emoji?: string;
  kind?: string;
  running: boolean;
  memLimit: number | null;
  pids: number | null;
  now: PerfPoint | null;
  history: PerfPoint[];
  containers: PerfContainer[];
}

export interface PerfData {
  interval: number;
  range: PerfRange;
  host: { info: HostInfo | null; now: HostNow | null; history: PerfPoint[] };
  groups: PerfGroup[];
}

export interface InstancePerf {
  interval: number;
  range: PerfRange;
  cores: number | null;
  group: PerfGroup | null;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const rate = (n: number | null | undefined) => (n == null ? "—" : `${bytes(n)}/s`);

export function cores(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n > 0 && n < 0.01) return "<0.01 核";
  return `${n.toFixed(n < 10 ? 2 : 1)} 核`;
}

export const percent = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);

export function duration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

export const ROLE_LABEL: Record<string, string> = {
  desktop: "画面与控制",
  android: "安卓系统",
  agent: "agent 容器",
  hub: "hub",
  office: "Office 文档服务",
};

export const RANGES: { value: PerfRange; label: string }[] = [
  { value: "1h", label: "1 小时" },
  { value: "24h", label: "24 小时" },
];
