import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-perf-"));
process.env.CONSTELLA_DATA_DIR = tmp;

const { Series, sumPoints, groupOf, parseMeminfo, parseProcStat, parseNetDev, parseCpuMax, parseKeyValues, PerfMonitor } = await import("../src/perf.ts");

describe("parsers", () => {
  it("reads meminfo in bytes", () => {
    const m = parseMeminfo("MemTotal:       33554432 kB\nMemAvailable:   1024 kB\nHugePages_Total:       0\n");
    expect(m.MemTotal).toBe(33554432 * 1024);
    expect(m.MemAvailable).toBe(1024 * 1024);
    expect(m.HugePages_Total).toBe(0);
  });

  it("counts busy jiffies without idle and iowait", () => {
    expect(parseProcStat("cpu  10 0 5 80 5 0 0 0 0 0\ncpu0 1 2 3 4\n")).toEqual({ busy: 15, total: 100 });
    expect(parseProcStat("")).toBeNull();
  });

  it("sums only real interfaces", () => {
    const dev = [
      "Inter-|   Receive",
      " face |bytes    packets",
      "    lo: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0",
      "  eth0: 1000 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0",
      "vethab12: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0",
      "docker0: 77 1 0 0 0 0 0 0 77 1 0 0 0 0 0 0",
      "tailscale0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0",
    ].join("\n");
    expect(parseNetDev(dev)).toEqual({ rx: 1010, tx: 220 });
  });

  it("reads cpu.max quotas and key/value files", () => {
    expect(parseCpuMax("max 100000\n")).toBeNull();
    expect(parseCpuMax("200000 100000\n")).toBe(2);
    expect(parseKeyValues("anon 10\nfile 20\n")).toEqual({ anon: 10, file: 20 });
  });
});

describe("Series", () => {
  it("keeps raw samples and folds the day into per-minute averages", () => {
    const s = new Series<{ t: number; cpu: number | null }>();
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    s.push({ t: base, cpu: 0.2 });
    s.push({ t: base + 30_000, cpu: 0.4 });
    s.push({ t: base + 60_000, cpu: null });
    s.push({ t: base + 70_000, cpu: 1 });
    expect(s.get("1h")).toHaveLength(4);
    const day = s.get("24h");
    expect(day).toHaveLength(2);
    expect(day[0]).toEqual({ t: base, cpu: expect.closeTo(0.3, 5) });
    // Missing values don't drag the average down.
    expect(day[1]).toEqual({ t: base + 60_000, cpu: 1 });
  });

  it("adds series point by point", () => {
    const sum = sumPoints([
      [
        { t: 1, cpu: 1, mem: null },
        { t: 2, cpu: 2, mem: 5 },
      ],
      [{ t: 2, cpu: 3, mem: 1 }],
    ]);
    expect(sum).toEqual([
      { t: 1, cpu: 1, mem: null },
      { t: 2, cpu: 5, mem: 6 },
    ]);
  });

  it("groups containers and only sums limits when all have one", () => {
    const c = (name: string, memLimit: number | null, mem: number) => ({
      name,
      role: "desktop",
      agentId: null,
      desktopId: "d1",
      running: true,
      memLimit,
      pids: 3,
      now: { t: 1, cpu: 0.5, mem, rx: 1, tx: 2 },
      history: [{ t: 1, cpu: 0.5, mem, rx: 1, tx: 2 }],
    });
    const g = groupOf({ type: "instance", id: "d1", name: "安卓" }, [c("a", 100, 10), c("b", 50, 20)]);
    expect(g).toMatchObject({ running: true, memLimit: 150, pids: 6, now: { cpu: 1, mem: 30, rx: 2, tx: 4 } });
    expect(g.containers[0]).not.toHaveProperty("history");
    expect(groupOf({ type: "instance", id: "d1", name: "x" }, [c("a", null, 1), c("b", 50, 1)]).memLimit).toBeNull();
    expect(groupOf({ type: "instance", id: "d2", name: "停了" }, [])).toMatchObject({ running: false, now: null, memLimit: null });
  });
});

describe("PerfMonitor", () => {
  /** A host root laid out like the read-only mounts in deploy/docker-compose.yml, inside an LXC-like cgroup. */
  function hostRoot() {
    const root = fs.mkdtempSync(path.join(tmp, "host-"));
    const cg = path.join(root, "sys", "fs", "cgroup");
    fs.mkdirSync(cg, { recursive: true });
    fs.mkdirSync(path.join(root, "proc", "1", "net"), { recursive: true });
    const write = (f: string, v: string) => fs.writeFileSync(path.join(root, f), v);
    write("proc/1/stat", "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0");
    write("sys/fs/cgroup/memory.max", "max\n");
    write("sys/fs/cgroup/cpu.max", "max 100000\n");
    const set = (usageUsec: number, current: number, file: number, rx: number, tx: number) => {
      write("sys/fs/cgroup/cpu.stat", `usage_usec ${usageUsec}\nuser_usec 1\n`);
      write("sys/fs/cgroup/memory.current", `${current}\n`);
      write("sys/fs/cgroup/memory.stat", `anon 1\nfile ${file}\n`);
      write("proc/1/net/dev", `h1\nh2\n  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`);
    };
    return { root, set };
  }

  function fakeDocker(cpuNs: () => number) {
    const containers = [
      { Id: "c1", Names: ["/constella-desktop-d1"], State: "running", Labels: { "dev.constella.role": "desktop", "dev.constella.desktop": "d1" } },
      { Id: "c2", Names: ["/constella-agent-a1"], State: "exited", Labels: { "dev.constella.role": "agent", "dev.constella.agent": "a1" } },
      { Id: "c3", Names: ["/probe"], State: "running", Labels: { "dev.constella.role": "probe" } },
    ];
    return {
      info: async () => ({ Name: "box", NCPU: 4, MemTotal: 8 * 1024 ** 3, OperatingSystem: "Debian", KernelVersion: "6.8", ServerVersion: "28" }),
      listContainers: async (opts: { filters: { id?: string[] } }) => (opts.filters.id ? [] : containers),
      getContainer: (id: string) => ({
        inspect: async () => {
          throw Object.assign(new Error("no such container"), { statusCode: 404, id });
        },
        stats: async () => ({
          cpu_stats: { cpu_usage: { total_usage: cpuNs() } },
          memory_stats: { usage: 600, limit: 2048, stats: { inactive_file: 100 } },
          networks: { eth0: { rx_bytes: 0, tx_bytes: 0 } },
          pids_stats: { current: 12 },
        }),
      }),
    };
  }

  it("samples an LXC-style host from its cgroup and containers from docker stats", async () => {
    const h = hostRoot();
    let ns = 0;
    const perf = new PerfMonitor({ docker: fakeDocker(() => ns) as any, hostRoot: h.root });
    h.set(1_000_000, 3000, 1000, 0, 0);
    await perf.sample();
    // Nothing to compare with yet: no rates.
    expect(perf.host("1h").history).toHaveLength(0);
    expect(perf.host("1h").info).toMatchObject({ scope: "cgroup", cores: 4, memTotal: expect.any(Number), network: true });

    await new Promise((r) => setTimeout(r, 20));
    ns = 2e9;
    h.set(1_000_000 + 4 * 1e6, 5000, 1000, 10_000, 5_000);
    await perf.sample();
    const host = perf.host("1h");
    expect(host.history).toHaveLength(1);
    expect(host.now?.mem).toBe(4000);
    expect(host.now?.memCache).toBe(1000);
    expect(host.now?.cpu).toBeGreaterThan(0);
    expect(host.now?.cpu).toBeLessThanOrEqual(1);
    expect(host.now?.rx).toBeGreaterThan(0);

    const list = perf.containers("1h");
    expect(list.map((c) => c.name).sort()).toEqual(["constella-agent-a1", "constella-desktop-d1"]);
    const desk = list.find((c) => c.desktopId === "d1")!;
    expect(desk).toMatchObject({ running: true, memLimit: 2048, pids: 12, now: { mem: 500 } });
    expect(desk.now!.cpu).toBeGreaterThan(0);
    expect(list.find((c) => c.agentId === "a1")).toMatchObject({ running: false, now: null });
  });
});
