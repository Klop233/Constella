import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import { config } from "./config.ts";

/** Seconds between samples; the last hour keeps every sample, the last day one average per minute. */
export const PERF_INTERVAL_S = 10;
const RAW_KEEP = 3600 / PERF_INTERVAL_S;
const MINUTES_KEEP = 24 * 60;

export type PerfRange = "1h" | "24h";

/** Host sample: cpu is the busy share of the host's capacity (0–1), memory in bytes, network in bytes/s (null when not visible). */
export type HostPoint = {
  t: number;
  cpu: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
};

/** Container sample: cpu in cores, memory in bytes (page cache excluded, like docker stats), network in bytes/s. */
export type ContainerPoint = {
  t: number;
  cpu: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
};

type Point = { t: number } & Record<string, number | null>;

/** A rolling series: every sample for the last hour, one average per minute for the last day. */
export class Series<P extends Point> {
  raw: P[] = [];
  minutes: P[] = [];
  #bucket: { minute: number; sums: Record<string, number>; counts: Record<string, number> } | null = null;

  push(p: P): void {
    this.raw.push(p);
    if (this.raw.length > RAW_KEEP) this.raw.splice(0, this.raw.length - RAW_KEEP);
    const minute = Math.floor(p.t / 60_000);
    if (this.#bucket && this.#bucket.minute !== minute) this.#flush();
    this.#bucket ??= { minute, sums: {}, counts: {} };
    for (const [k, v] of Object.entries(p)) {
      if (k === "t" || v == null) continue;
      this.#bucket.sums[k] = (this.#bucket.sums[k] ?? 0) + v;
      this.#bucket.counts[k] = (this.#bucket.counts[k] ?? 0) + 1;
    }
  }

  get(range: PerfRange): P[] {
    if (range === "1h") return this.raw;
    const open = this.#bucket ? [this.#average(this.#bucket)] : [];
    return [...this.minutes, ...open];
  }

  get last(): P | undefined {
    return this.raw.at(-1);
  }

  #flush(): void {
    if (!this.#bucket) return;
    this.minutes.push(this.#average(this.#bucket));
    if (this.minutes.length > MINUTES_KEEP) this.minutes.splice(0, this.minutes.length - MINUTES_KEEP);
    this.#bucket = null;
  }

  #average(b: { minute: number; sums: Record<string, number>; counts: Record<string, number> }): P {
    const keys = new Set([...Object.keys(this.raw.at(-1) ?? {}), ...Object.keys(b.sums)]);
    keys.delete("t");
    const p: Point = { t: b.minute * 60_000 };
    for (const k of keys) p[k] = b.counts[k] ? b.sums[k]! / b.counts[k]! : null;
    return p as P;
  }
}

/** Point-wise sum of series sampled on the same ticks (an Android instance is two containers). */
export function sumPoints<P extends Point>(lists: P[][]): P[] {
  if (lists.length === 1) return lists[0]!;
  const byT = new Map<number, Point>();
  for (const list of lists)
    for (const p of list) {
      const acc: Point = byT.get(p.t) ?? { t: p.t };
      for (const [k, v] of Object.entries(p)) {
        if (k === "t") continue;
        acc[k] = v == null ? (acc[k] ?? null) : ((acc[k] as number | null) ?? 0) + v;
      }
      byT.set(p.t, acc);
    }
  return [...byT.values()].sort((a, b) => a.t - b.t) as P[];
}

// ── /proc and cgroup parsing (pure, unit-tested) ──────────────

export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) * (line.includes("kB") ? 1024 : 1);
  }
  return out;
}

/** Aggregate cpu line of /proc/stat → busy and total jiffies. */
export function parseProcStat(text: string): { busy: number; total: number } | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal (guest time is already counted in user)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, total };
}

/** Flat "key value" files such as cgroup memory.stat and cpu.stat. */
export function parseKeyValues(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v && /^\d+$/.test(v)) out[k] = Number(v);
  }
  return out;
}

/** Virtual interfaces carry container traffic that the physical ones already count. */
const VIRTUAL_NIC = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan|kube)/;

/** Received and sent bytes over the host's real interfaces, from /proc/<pid>/net/dev. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m || VIRTUAL_NIC.test(m[1]!.trim())) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    rx += f[0] ?? 0;
    tx += f[8] ?? 0;
  }
  return { rx, tx };
}

/** cpu.max → cores the cgroup may use (null when unlimited). */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === "max" || !period) return null;
  return Number(quota) / Number(period);
}

const read = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

// ── the monitor ───────────────────────────────────────────────

export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  cpuModel: string;
  /** Cores the host can use (the cgroup quota when it has one). */
  cores: number;
  memTotal: number | null;
  swapTotal: number | null;
  disk: { path: string; total: number } | null;
  /**
   * Where the numbers come from: "host" = the kernel's own counters (the hub runs straight on the machine);
   * "cgroup" = the cgroup the container runtime lives in (an LXC container or similar slice of a bigger machine);
   * "container" = no host view mounted, so the hub's own /proc (memory may show the physical machine).
   */
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

export interface ContainerView {
  name: string;
  /** dev.constella.role label, "hub" for the hub itself. */
  role: string;
  agentId: string | null;
  desktopId: string | null;
  running: boolean;
  /** Memory limit in bytes (null: no limit below the host's). */
  memLimit: number | null;
  pids: number | null;
  now: ContainerPoint | null;
  history: ContainerPoint[];
}

interface Tracked {
  name: string;
  role: string;
  agentId: string | null;
  desktopId: string | null;
  running: boolean;
  memLimit: number | null;
  pids: number | null;
  seenAt: number;
  prev: { t: number; cpu: number; rx: number; tx: number } | null;
  series: Series<ContainerPoint>;
}

const SKIP_ROLES = new Set(["probe", "host-exec", "network"]);

/**
 * Samples the host and Constella's own containers every few seconds and keeps a day of history in memory.
 * The host is read through its /proc and cgroup mounted read-only at CONSTELLA_HOST_ROOT (see deploy/docker-compose.yml);
 * without them it falls back to what the hub container itself sees.
 */
export class PerfMonitor {
  #docker: Docker;
  #root: string;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #host = new Series<HostPoint>();
  #hostPrev: { t: number; cpuBusy: number; cpuTotal: number; rx: number; tx: number } | null = null;
  #now: HostNow | null = null;
  #info: HostInfo | null = null;
  #infoAt = 0;
  #containers = new Map<string, Tracked>();
  #hubId: string | null | undefined;
  #warned = false;

  constructor(opts: { docker: Docker; hostRoot?: string }) {
    this.#docker = opts.docker;
    this.#root = opts.hostRoot ?? config.hostRoot;
  }

  start(): void {
    if (this.#timer) return;
    void this.sample();
    this.#timer = setInterval(() => void this.sample(), PERF_INTERVAL_S * 1000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  get #hostProc(): string | null {
    const p = path.join(this.#root, "proc");
    return fs.existsSync(path.join(p, "1", "stat")) ? p : null;
  }

  /** The cgroup the host's processes live in, when it is a slice (LXC and the like) rather than the machine's root. */
  get #hostCgroup(): string | null {
    const p = path.join(this.#root, "sys", "fs", "cgroup");
    return fs.existsSync(path.join(p, "memory.current")) ? p : null;
  }

  async #refreshInfo(): Promise<HostInfo> {
    if (this.#info && Date.now() - this.#infoAt < 300_000) return this.#info;
    const d: any = await this.#docker.info().catch(() => null);
    const cg = this.#hostCgroup;
    const meminfo = parseMeminfo(read("/proc/meminfo") ?? "");
    const quota = cg ? parseCpuMax(read(path.join(cg, "cpu.max")) ?? "") : null;
    const cgMax = cg ? Number(read(path.join(cg, "memory.max"))?.trim()) : NaN;
    // Docker reports what its own environment sees (lxcfs-adjusted inside LXC), so it is the better total.
    const totals = [d?.MemTotal, meminfo.MemTotal, Number.isFinite(cgMax) ? cgMax : undefined].filter((v): v is number => typeof v === "number" && v > 0);
    let disk: HostInfo["disk"] = null;
    try {
      const s = fs.statfsSync(config.dataDir);
      disk = { path: config.dataDir, total: s.blocks * s.bsize };
    } catch {}
    const swapMax = cg ? Number(read(path.join(cg, "memory.swap.max"))?.trim()) : NaN;
    this.#info = {
      hostname: d?.Name ?? os.hostname(),
      os: d?.OperatingSystem ?? `${os.type()} ${os.release()}`,
      kernel: d?.KernelVersion ?? os.release(),
      cpuModel: (os.cpus()[0]?.model ?? "").replace(/\s+/g, " ").trim(),
      cores: quota ?? d?.NCPU ?? os.cpus().length,
      memTotal: totals.length ? Math.min(...totals) : null,
      swapTotal: cg ? (Number.isFinite(swapMax) ? swapMax : null) : (meminfo.SwapTotal ?? null),
      disk,
      scope: cg ? "cgroup" : this.#hostProc ? "host" : "container",
      network: !!this.#hostProc,
      dockerVersion: d?.ServerVersion ?? "",
    };
    this.#infoAt = Date.now();
    return this.#info;
  }

  /** One sampling tick: host counters, then every Constella container in parallel. */
  async sample(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const t = Date.now();
      const info = await this.#refreshInfo();
      await this.#sampleContainers(t);
      this.#sampleHost(t, info);
    } catch (err) {
      if (!this.#warned) console.error("perf sample failed", err);
      this.#warned = true;
    } finally {
      this.#busy = false;
    }
  }

  #sampleHost(t: number, info: HostInfo): void {
    const cg = this.#hostCgroup;
    const hp = this.#hostProc;
    let cpuBusy: number | null = null;
    let cpuTotal: number | null = null;
    let mem: number | null = null;
    let memCache: number | null = null;
    let swap: number | null = null;
    if (cg) {
      const usage = parseKeyValues(read(path.join(cg, "cpu.stat")) ?? "").usage_usec;
      if (usage != null) {
        cpuBusy = usage;
        cpuTotal = t * 1000 * info.cores;
      }
      const current = Number(read(path.join(cg, "memory.current"))?.trim());
      const ms = parseKeyValues(read(path.join(cg, "memory.stat")) ?? "");
      if (Number.isFinite(current)) {
        memCache = ms.file ?? 0;
        mem = Math.max(0, current - memCache);
      }
      const sw = Number(read(path.join(cg, "memory.swap.current"))?.trim());
      swap = Number.isFinite(sw) ? sw : null;
    } else {
      const st = parseProcStat(read("/proc/stat") ?? "");
      if (st) {
        cpuBusy = st.busy;
        cpuTotal = st.total;
      }
      const mi = parseMeminfo(read("/proc/meminfo") ?? "");
      if (mi.MemTotal != null && mi.MemAvailable != null) mem = mi.MemTotal - mi.MemAvailable;
      memCache = (mi.Cached ?? 0) + (mi.Buffers ?? 0);
      swap = mi.SwapTotal != null && mi.SwapFree != null ? mi.SwapTotal - mi.SwapFree : null;
    }
    const net = hp ? parseNetDev(read(path.join(hp, "1", "net", "dev")) ?? "") : null;
    const prev = this.#hostPrev;
    const dt = prev ? (t - prev.t) / 1000 : 0;
    const rate = (a: number | undefined, b: number | undefined) => (prev && dt > 0 && a != null && b != null ? Math.max(0, (a - b) / dt) : null);
    let cpu: number | null = null;
    if (prev && cpuBusy != null && cpuTotal != null) {
      const dTotal = cpuTotal - prev.cpuTotal;
      // cgroup usage is in µs against wall time × cores; /proc/stat is jiffies of busy against all.
      if (dTotal > 0) cpu = Math.min(1, Math.max(0, (cpuBusy - prev.cpuBusy) / dTotal));
    }
    const point: HostPoint = { t, cpu, mem, rx: rate(net?.rx, prev?.rx), tx: rate(net?.tx, prev?.tx) };
    if (cpuBusy != null && cpuTotal != null) this.#hostPrev = { t, cpuBusy, cpuTotal, rx: net?.rx ?? 0, tx: net?.tx ?? 0 };
    if (prev) this.#host.push(point);
    let diskUsed: number | null = null;
    try {
      const s = fs.statfsSync(config.dataDir);
      diskUsed = (s.blocks - s.bfree) * s.bsize;
    } catch {}
    this.#now = { cpu, mem, memCache, swap, load: os.loadavg() as [number, number, number], uptimeS: this.#uptime(hp), diskUsed, rx: point.rx, tx: point.tx };
  }

  /** How long the host has been up: inside LXC that is the container's init, not the physical machine's kernel. */
  #uptime(hp: string | null): number {
    const kernel = os.uptime();
    if (!hp) return kernel;
    const stat = read(path.join(hp, "1", "stat"));
    // Field 22 (after the parenthesised command name) is the start time in clock ticks.
    const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = Number(fields?.[19]);
    return Number.isFinite(start) && start > 0 ? Math.max(0, kernel - start / 100) : kernel;
  }

  async #hubContainerId(): Promise<string | null> {
    if (this.#hubId !== undefined) return this.#hubId;
    try {
      this.#hubId = (await this.#docker.getContainer(os.hostname()).inspect()).Id;
    } catch {
      this.#hubId = null;
    }
    return this.#hubId;
  }

  async #sampleContainers(t: number): Promise<void> {
    const list = await this.#docker.listContainers({ all: true, filters: { label: ["dev.constella.role"] } });
    const hubId = await this.#hubContainerId();
    const hub = hubId ? await this.#docker.listContainers({ all: true, filters: { id: [hubId] } }).catch(() => []) : [];
    const memTotal = this.#info?.memTotal ?? null;
    const seen = new Set<string>();
    await Promise.all(
      [...list, ...hub].map(async (c) => {
        const labels = c.Labels ?? {};
        const role = c.Id === hubId ? "hub" : (labels["dev.constella.role"] ?? "");
        if (SKIP_ROLES.has(role)) return;
        const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
        seen.add(name);
        const tr: Tracked = this.#containers.get(name) ?? {
          name,
          role,
          agentId: labels["dev.constella.agent"] ?? null,
          desktopId: labels["dev.constella.desktop"] ?? null,
          running: false,
          memLimit: null,
          pids: null,
          seenAt: t,
          prev: null,
          series: new Series<ContainerPoint>(),
        };
        this.#containers.set(name, tr);
        tr.seenAt = t;
        tr.running = c.State === "running";
        if (!tr.running) {
          tr.prev = null;
          tr.pids = null;
          return;
        }
        const s: any = await (this.#docker.getContainer(c.Id).stats({ stream: false, "one-shot": true } as any) as unknown as Promise<unknown>).catch(() => null);
        if (!s?.cpu_stats) return;
        const cpuNs = Number(s.cpu_stats.cpu_usage?.total_usage ?? 0);
        const nets = Object.values((s.networks ?? {}) as Record<string, { rx_bytes: number; tx_bytes: number }>);
        const rx = nets.reduce((n, x) => n + (x.rx_bytes ?? 0), 0);
        const tx = nets.reduce((n, x) => n + (x.tx_bytes ?? 0), 0);
        const ms = s.memory_stats ?? {};
        const cache = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? 0;
        const mem = ms.usage != null ? Math.max(0, ms.usage - cache) : null;
        const limit = Number(ms.limit ?? 0);
        tr.memLimit = limit > 0 && (memTotal == null || limit < memTotal * 0.98) ? limit : null;
        tr.pids = s.pids_stats?.current ?? null;
        const p = tr.prev;
        const dt = p ? (t - p.t) / 1000 : 0;
        const point: ContainerPoint = {
          t,
          cpu: p && dt > 0 ? Math.max(0, (cpuNs - p.cpu) / 1e9 / dt) : null,
          mem,
          rx: p && dt > 0 ? Math.max(0, (rx - p.rx) / dt) : null,
          tx: p && dt > 0 ? Math.max(0, (tx - p.tx) / dt) : null,
        };
        tr.prev = { t, cpu: cpuNs, rx, tx };
        if (p) tr.series.push(point);
      }),
    );
    // Forget containers that have been gone (removed) for a day.
    for (const [name, tr] of this.#containers) {
      if (seen.has(name)) continue;
      tr.running = false;
      tr.prev = null;
      if (t - tr.seenAt > 86_400_000) this.#containers.delete(name);
    }
  }

  host(range: PerfRange): { info: HostInfo | null; now: HostNow | null; history: HostPoint[] } {
    return { info: this.#info, now: this.#now, history: this.#host.get(range) };
  }

  containers(range: PerfRange | null): ContainerView[] {
    return [...this.#containers.values()].map((c) => ({
      name: c.name,
      role: c.role,
      agentId: c.agentId,
      desktopId: c.desktopId,
      running: c.running,
      memLimit: c.memLimit,
      pids: c.pids,
      now: c.running ? (c.series.last ?? null) : null,
      history: range ? c.series.get(range) : [],
    }));
  }
}

/** A thing the owner recognises (an instance, an agent, the hub) with its containers added up. */
export interface PerfGroup {
  type: "instance" | "agent" | "system";
  id: string;
  name: string;
  emoji?: string;
  kind?: string;
  running: boolean;
  /** Sum of the containers' limits; null when any of them has none. */
  memLimit: number | null;
  pids: number | null;
  now: ContainerPoint | null;
  history: ContainerPoint[];
  containers: Omit<ContainerView, "history">[];
}

export function groupOf(meta: Pick<PerfGroup, "type" | "id" | "name" | "emoji" | "kind">, containers: ContainerView[]): PerfGroup {
  const live = containers.filter((c) => c.running);
  const nows = live.map((c) => c.now).filter((p): p is ContainerPoint => !!p);
  return {
    ...meta,
    running: live.length > 0,
    memLimit: containers.length && containers.every((c) => c.memLimit != null) ? containers.reduce((n, c) => n + c.memLimit!, 0) : null,
    pids: live.length ? live.reduce((n, c) => n + (c.pids ?? 0), 0) : null,
    now: nows.length ? (sumPoints(nows.map((p) => [p]))[0] ?? null) : null,
    history: containers.length ? sumPoints(containers.map((c) => c.history)) : [],
    containers: containers.map(({ history: _h, ...c }) => c),
  };
}
