import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-inst-"));
process.env.CONSTELLA_DATA_DIR = tmp;

const { openDb } = await import("../src/db.ts");
const { EventStore } = await import("../src/events.ts");
const { Desktops, DesktopError, boundIds, clearStaleLocks } = await import("../src/desktops.ts");
const { HostCapabilities } = await import("../src/hostcaps.ts");
const { registerMcp } = await import("../src/mcp.ts");
const { config } = await import("../src/config.ts");

type Db = ReturnType<typeof openDb>;

function addAgent(db: Db, id: string, policy: unknown): void {
  db.prepare(
    `INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at)
     VALUES (?, ?, '✨', 'assistant', 'p', 'm', 'auto', ?, ?, 'now', 'now')`,
  ).run(id, id, JSON.stringify(policy), `h-${id}`);
}

function policy(db: Db, id: string): unknown {
  return JSON.parse((db.prepare("SELECT desktop_policy FROM agents WHERE id = ?").get(id) as { desktop_policy: string }).desktop_policy);
}

/** Containers stand-in: every container "exists" in the given state; records lifecycle calls. */
function fakeContainers(initial = "running") {
  const states = new Map<string, string>();
  const infos = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const logs = new Map<string, string>();
  return {
    calls,
    states,
    infos,
    logLines: logs,
    desktopName: (id: string) => `constella-desktop-${id}`,
    androidName: (id: string) => `constella-android-${id}`,
    state: async (name: string) => states.get(name) ?? initial,
    info: async (name: string) => ({
      state: states.get(name) ?? initial,
      restartCount: 0,
      restarting: false,
      startedAt: null,
      exitCode: null,
      oomKilled: false,
      health: null,
      ...infos.get(name),
    }),
    logs: async (name: string) => logs.get(name) ?? "",
    pause: async (name: string) => void (calls.push(`pause ${name}`), states.set(name, "paused")),
    unpause: async (name: string) => void (calls.push(`unpause ${name}`), states.set(name, "running")),
    stop: async (name: string) => void (calls.push(`stop ${name}`), states.set(name, "stopped")),
    remove: async (name: string) => void calls.push(`remove ${name}`),
    ensureDesktop: async (spec: { desktopId: string }) => void calls.push(`ensure ${spec.desktopId}`),
  };
}

function caps(over: { android?: boolean; backend?: "redroid" | "emulator"; arm?: boolean; gapps?: boolean } = {}) {
  const b = { ok: true, arm: over.arm ?? true, googlePlay: over.gapps ?? false };
  const snap = {
    checkedAt: "now",
    checking: false,
    kinds: { browser: { ok: true }, desktop: { ok: true }, android: over.android === false ? { ok: false, reason: "宿主没有 binder" } : { ok: true } },
    android: { setting: "auto", backend: over.android === false ? null : (over.backend ?? "redroid"), redroid: b, emulator: b },
  };
  return { get: async () => snap, snapshot: () => snap } as any;
}

function setup(opts: { containers?: ReturnType<typeof fakeContainers>; caps?: any; settings?: any } = {}) {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const containers = opts.containers ?? fakeContainers();
  const desktops = new Desktops({ db, events, containers: containers as any, runs: {} as any, caps: opts.caps, settings: opts.settings });
  return { db, events, containers, desktops };
}

describe("instance bindings", () => {
  it("reads both the new and the old policy shapes", () => {
    expect(boundIds('{"desktopIds":["a","b"]}')).toEqual(["a", "b"]);
    expect(boundIds('{"mode":"fixed","desktopId":"x"}')).toEqual(["x"]);
    expect(boundIds('{"mode":"on_demand"}')).toEqual([]);
    expect(boundIds("garbage")).toEqual([]);
  });

  it("migrates old databases: adds kind/options and rewrites none / fixed / on_demand policies", () => {
    const file = path.join(tmp, "legacy.db");
    let db = openDb(file);
    db.exec("ALTER TABLE desktops DROP COLUMN kind; ALTER TABLE desktops DROP COLUMN options;");
    const ins = db.prepare("INSERT INTO desktops (id, name, lease, pinned_agent_id, created_at, last_used_at) VALUES (?, ?, '{\"holder\":\"none\"}', ?, ?, 'now')");
    ins.run("d1", "公共", null, "2026-01-01");
    ins.run("d2", "给 b 的", "b", "2026-01-02");
    ins.run("d3", "给 c 的", "c", "2026-01-03");
    addAgent(db, "a", { mode: "on_demand" });
    addAgent(db, "b", { mode: "on_demand" });
    addAgent(db, "c", { mode: "fixed", desktopId: "d3" });
    addAgent(db, "n", { mode: "none" });
    addAgent(db, "g", { mode: "fixed", desktopId: "gone" });
    db.close();

    db = openDb(file);
    expect((db.prepare("SELECT kind, options FROM desktops WHERE id = 'd1'").get() as any)).toEqual({ kind: "desktop", options: "{}" });
    expect(policy(db, "a")).toEqual({ desktopIds: ["d1"] });
    expect(policy(db, "b")).toEqual({ desktopIds: ["d1", "d2"] });
    expect(policy(db, "c")).toEqual({ desktopIds: ["d3"] });
    expect(policy(db, "n")).toEqual({ desktopIds: [] });
    expect(policy(db, "g")).toEqual({ desktopIds: [] });
    db.close();
    // Idempotent: a second open changes nothing.
    db = openDb(file);
    expect(policy(db, "b")).toEqual({ desktopIds: ["d1", "d2"] });
    db.close();
  });

  it("binds and unbinds an instance per agent, and unbinds it everywhere when removed", async () => {
    const { db, desktops } = setup();
    addAgent(db, "a", { desktopIds: [] });
    addAgent(db, "b", { desktopIds: [] });
    const x = await desktops.create({ name: "x", kind: "browser" });
    const y = await desktops.create({ name: "y", kind: "desktop" });
    desktops.setAgents(x.id, ["a", "b"]);
    desktops.setAgents(y.id, ["a"]);
    expect(desktops.agentIds(x.id)).toEqual(["a", "b"]);
    expect(desktops.boundTo("a").map((r) => r.id)).toEqual([x.id, y.id]);
    desktops.setAgents(x.id, ["b"]);
    expect(policy(db, "a")).toEqual({ desktopIds: [y.id] });
    await desktops.remove(x.id);
    expect(policy(db, "b")).toEqual({ desktopIds: [] });
    expect(desktops.rows().map((r) => r.id)).toEqual([y.id]);
  });
});

describe("picking the instance a tool call acts on", () => {
  async function three() {
    const s = setup();
    addAgent(s.db, "a", { desktopIds: [] });
    const phone = await s.desktops.create({ name: "手机", kind: "android" });
    const web = await s.desktops.create({ name: "网页", kind: "browser" });
    const linux = await s.desktops.create({ name: "桌面", kind: "desktop" });
    s.db.prepare("UPDATE agents SET desktop_policy = ? WHERE id = 'a'").run(JSON.stringify({ desktopIds: [phone.id, web.id, linux.id] }));
    return { ...s, phone, web, linux };
  }

  it("uses bound order for the screen, prefers a bare browser for browser_*, and holds several at once", async () => {
    const { desktops, phone, web } = await three();
    expect(await desktops.acquire("a", "r1", "screen")).toBe(phone.id);
    expect(await desktops.acquire("a", "r1", "web")).toBe(web.id);
    expect(await desktops.acquire("a", "r1", "screen")).toBe(phone.id);
    expect(desktops.lease(phone.id)).toMatchObject({ holder: "agent", runId: "r1" });
    expect(desktops.lease(web.id)).toMatchObject({ holder: "agent", runId: "r1" });
    desktops.releaseRun("r1");
    expect(desktops.lease(phone.id).holder).toBe("none");
    expect(desktops.lease(web.id).holder).toBe("none");
    expect(desktops.current("r1")).toBeUndefined();
  });

  it("switches with instance_use: desktop_* and (with a browser) browser_* follow", async () => {
    const { desktops, linux, phone } = await three();
    desktops.use("a", "r1", linux.id);
    expect(await desktops.acquire("a", "r1", "screen")).toBe(linux.id);
    expect(await desktops.acquire("a", "r1", "web")).toBe(linux.id);
    desktops.use("a", "r1", phone.id);
    expect(await desktops.acquire("a", "r1", "screen")).toBe(phone.id);
    expect(await desktops.acquire("a", "r1", "web")).toBe(linux.id); // Android has no browser_* browser
    expect(() => desktops.use("a", "r1", "dt-nope")).toThrow(DesktopError);
  });

  it("skips instances other runs hold and explains what to do when nothing fits", async () => {
    const { db, desktops, web, linux } = await three();
    addAgent(db, "b", { desktopIds: [web.id, linux.id] });
    expect(await desktops.acquire("b", "r2", "web")).toBe(web.id);
    expect(await desktops.acquire("a", "r1", "web")).toBe(linux.id);
    await expect(desktops.acquire("b", "r3", "web")).rejects.toMatchObject({ code: "busy" });
    addAgent(db, "lonely", { desktopIds: [] });
    await expect(desktops.acquire("lonely", "r4", "screen")).rejects.toThrow(/instance_create/);
  });

  it("thaws a paused instance instead of starting it again", async () => {
    const containers = fakeContainers();
    const s = setup({ containers });
    addAgent(s.db, "a", { desktopIds: [] });
    const d = await s.desktops.create({ name: "x", kind: "browser" });
    s.desktops.setAgents(d.id, ["a"]);
    containers.states.set(`constella-desktop-${d.id}`, "paused");
    const health = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as any;
    try {
      expect(await s.desktops.acquire("a", "r1")).toBe(d.id);
    } finally {
      globalThis.fetch = health;
    }
    expect(containers.calls).toContain(`unpause constella-desktop-${d.id}`);
    expect(containers.calls.some((c) => c.startsWith("ensure"))).toBe(false);
  });
});

describe("creating and changing instances", () => {
  it("enforces the instance limits", async () => {
    const { desktops } = setup({ settings: { maxInstances: () => 2, maxAndroid: () => 1 } });
    await desktops.create({ name: "1", kind: "android" });
    await expect(desktops.create({ name: "2", kind: "android" })).rejects.toMatchObject({ code: "limit" });
    await desktops.create({ name: "3", kind: "browser" });
    await expect(desktops.create({ name: "4", kind: "browser" })).rejects.toMatchObject({ code: "limit" });
  });

  it("refuses kinds and options the host can't provide, and fills in the Android backend", async () => {
    const off = setup({ caps: caps({ android: false }) });
    await expect(off.desktops.create({ name: "x", kind: "android" })).rejects.toThrow(/binder/);
    const nogapps = setup({ caps: caps({ gapps: false }) });
    await expect(nogapps.desktops.create({ name: "x", kind: "android", options: { googlePlay: true } })).rejects.toMatchObject({ code: "unavailable" });
    const ok = setup({ caps: caps({ arm: true }) });
    const r = await ok.desktops.create({ name: "x", kind: "android", options: { dpi: 240, width: 1080 } });
    expect(ok.desktops.options(r)).toEqual({ dpi: 240, width: 1080, backend: "redroid", armTranslation: true });
    expect(ok.desktops.spec(r)).toMatchObject({ kind: "android", width: 1080, height: 1280, dpi: 240, backend: "redroid", armTranslation: true, googlePlay: false });
    // Android-only options don't stick to other kinds.
    const b = await ok.desktops.create({ name: "b", kind: "browser", options: { googlePlay: true, width: 1440 } });
    expect(ok.desktops.options(b)).toEqual({ width: 1440 });
  });

  it("needs confirmation before rebuilding an emulator for Google Play, and keeps the backend fixed", async () => {
    const containers = fakeContainers("stopped");
    const s = setup({ containers, caps: caps({ backend: "emulator", gapps: true }) });
    const r = await s.desktops.create({ name: "x", kind: "android" });
    expect(s.desktops.options(r).backend).toBe("emulator");
    await expect(s.desktops.update(r.id, { options: { googlePlay: true } })).rejects.toMatchObject({ code: "confirm" });
    expect(await s.desktops.update(r.id, { options: { googlePlay: true, backend: "redroid" } }, { confirmDataLoss: true })).toEqual({ restarted: false, wiped: true });
    expect(s.desktops.options(s.desktops.row(r.id))).toMatchObject({ backend: "emulator", googlePlay: true });
  });

  it("restarts a running instance so changed options apply", async () => {
    const containers = fakeContainers("running");
    const s = setup({ containers, caps: caps() });
    const r = await s.desktops.create({ name: "x", kind: "android" });
    const health = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as any;
    try {
      expect(await s.desktops.update(r.id, { name: "y", options: { armTranslation: false } })).toEqual({ restarted: true, wiped: false });
      expect(await s.desktops.update(r.id, { name: "z" })).toEqual({ restarted: false, wiped: false });
    } finally {
      globalThis.fetch = health;
    }
    expect(s.desktops.row(r.id).name).toBe("z");
    expect(containers.calls).toEqual([`stop constella-desktop-${r.id}`, `stop constella-android-${r.id}`, `ensure ${r.id}`]);
  });
});

describe("idle instances", () => {
  it("pauses or stops per instance (falling back to the global setting) and leaves held ones alone", async () => {
    const containers = fakeContainers("running");
    const s = setup({ containers, settings: { idleMinutes: () => 30, idleAction: () => "pause" } });
    const old = "2026-01-01T00:00:00.000Z";
    const mk = async (name: string, kind: "browser" | "android", options = {}) => {
      const r = await s.desktops.create({ name, kind, options });
      s.db.prepare("UPDATE desktops SET last_used_at = ? WHERE id = ?").run(old, r.id);
      return r;
    };
    const p = await mk("pause", "browser");
    const st = await mk("stop", "android", { idleAction: "stop" });
    await mk("keep", "browser", { idleAction: "none" });
    await s.desktops.create({ name: "fresh", kind: "browser" });
    const held = await mk("held", "browser");
    s.db.prepare("UPDATE desktops SET lease = ?, last_used_at = ? WHERE id = ?").run(JSON.stringify({ holder: "human", since: old }), old, held.id);
    const health = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 500 })) as any; // no frame to keep
    try {
      await s.desktops.reap(Date.parse("2026-01-01T01:00:00.000Z"));
    } finally {
      globalThis.fetch = health;
    }
    expect(containers.calls.sort()).toEqual(
      [`pause constella-desktop-${p.id}`, `stop constella-desktop-${st.id}`, `stop constella-android-${st.id}`].sort(),
    );
  });
});

describe("host capabilities", () => {
  /** Docker stand-in: which images exist (with labels) and what the probe containers print. */
  function fakeDocker(o: { images: Record<string, Record<string, string>>; probe: string; kvm: "ok" | "missing" | "denied" }) {
    return {
      getImage: (tag: string) => ({ inspect: async () => (o.images[tag] ? { Config: { Labels: o.images[tag] } } : Promise.reject(new Error("no such image"))) }),
      createContainer: async (opts: any) => {
        const kvm = !!opts.HostConfig.Devices;
        if (kvm && o.kvm === "missing") throw new Error("error gathering device information: /dev/kvm: no such file or directory");
        const out = kvm ? (o.kvm === "ok" ? "KVM\n" : "") : o.probe;
        return { start: async () => {}, wait: async () => ({}), logs: async () => Buffer.from(out), remove: async () => {} };
      },
    } as any;
  }
  const d = config.docker;
  const all = {
    [d.desktopImage]: {},
    [d.androidBridgeImage]: {},
    [d.redroidImage]: { "dev.constella.android.arm": "1" },
    [d.emulatorImage]: {},
  };

  it("reports why Redroid and the emulator can't run in an unprivileged LXC without KVM", async () => {
    const hc = new HostCapabilities({ docker: fakeDocker({ images: all, probe: "BINDER\n", kvm: "missing" }), androidBackend: () => "auto" });
    const c = await hc.get();
    expect(c.kinds.browser.ok).toBe(true);
    expect(c.kinds.android.ok).toBe(false);
    expect(c.android.redroid.reason).toMatch(/内核参数/);
    expect(c.android.emulator.reason).toMatch(/\/dev\/kvm/);
    expect(c.android.backend).toBeNull();
  });

  it("picks Redroid when it works, reads image labels, and warns about short uid ranges", async () => {
    const hc = new HostCapabilities({ docker: fakeDocker({ images: all, probe: "BINDER\nSYSCTL\n", kvm: "denied" }), androidBackend: () => "auto" });
    const c = await hc.get();
    expect(c.android.backend).toBe("redroid");
    expect(c.android.redroid).toMatchObject({ ok: true, arm: true, googlePlay: false });
    expect(c.android.redroid.warnings?.[0]).toMatch(/uid/);
    expect(c.android.emulator.reason).toMatch(/无权/);
  });

  it("follows the setting: emulator only, or Android off", async () => {
    let setting: "emulator" | "off" = "emulator";
    const hc = new HostCapabilities({ docker: fakeDocker({ images: { ...all, [d.emulatorPlaystoreImage]: {} }, probe: "", kvm: "ok" }), androidBackend: () => setting });
    expect((await hc.get()).android).toMatchObject({ backend: "emulator", emulator: { ok: true, arm: true, googlePlay: true } });
    setting = "off";
    expect(hc.snapshot().kinds.android).toMatchObject({ ok: false, reason: expect.stringMatching(/关闭/) });
  });

  it("can't probe without the desktop image and says so", async () => {
    const hc = new HostCapabilities({ docker: fakeDocker({ images: {}, probe: "", kvm: "ok" }), androidBackend: () => "auto" });
    const c = await hc.get();
    expect(c.kinds.desktop.reason).toContain(d.desktopImage);
    expect(c.android.redroid.reason).toContain("无法检测");
  });
});

describe("instance tools over MCP", () => {
  it("creates an instance bound to the agent, asking the owner first when the setting says so", async () => {
    const db = openDb(":memory:");
    addAgent(db, "a", { desktopIds: [] });
    db.prepare(
      "INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, created_at, last_event_at) VALUES ('r1', 'c1', 'a', 'p', 'running', 'm', 'now', 'now')",
    ).run();
    const desktops = new Desktops({ db, events: new EventStore(db), containers: fakeContainers() as any, runs: {} as any, caps: caps() });
    let approval = { create: true, update: true };
    let answer = false;
    const asked: string[] = [];
    const repairs: unknown[] = [];
    const helped: string[] = [];
    const app = Fastify();
    registerMcp(app, {
      db,
      agents: { byToken: (t: string) => (t === "tok" ? { id: "a", name: "a", host_access: 0 } : undefined) },
      runs: {
        requestHubApproval: async (_r: string, _k: string, summary: string) => (asked.push(summary), answer),
        appendFor: () => {},
      },
      desktops,
      hostcaps: caps(),
      recovery: {
        repairInstance: async (id: string, ctx: { by: string; runId: string }) => {
          repairs.push({ id, by: ctx.by, runId: ctx.runId });
          return { ok: true, steps: ["停止了实例", "重新启动，确认已经可以正常使用"], before: { ok: false }, after: { ok: true } };
        },
        help: async (input: { problem: string }) => (helped.push(input.problem), { text: "维修员诊断：实例好了\n下一步：继续", diagnosis: "实例好了", did: [] }),
      },
      browserHtml: () => false,
      instanceApproval: () => approval,
    } as any);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const client = new Client({ name: "test", version: "0" });
    const url = new URL(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer tok" } } }));
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ["instance_list", "instance_use", "instance_create", "instance_update", "instance_restart", "android_ui", "android_apps"]) expect(names).toContain(n);

      const denied = await call("instance_create", { kind: "browser", name: "网页", reason: "查资料" });
      expect(denied.isError).toBe(true);
      expect(asked).toEqual(["新建浏览器实例「网页」"]);
      expect(desktops.rows()).toHaveLength(0);

      approval = { create: false, update: true };
      const ok = await call("instance_create", { kind: "android", name: "手机", googlePlay: false, reason: "装 App" });
      expect(ok.isError).toBeFalsy();
      const [row] = desktops.rows();
      expect(row).toMatchObject({ kind: "android", name: "手机" });
      expect(policy(db, "a")).toEqual({ desktopIds: [row!.id] });
      expect(desktops.current("r1")).toBe(row!.id);
      expect(asked).toHaveLength(1);

      const list = await call("instance_list", {});
      expect(list.content[0]!.text).toContain(`手机（安卓，id ${row!.id}）`);
      expect(list.content[0]!.text).toContain("当前");

      const notMine = await call("instance_update", { id: "dt-other", name: "x", reason: "r" });
      expect(notMine.isError).toBe(true);

      // Repairing never waits for the owner, even with the change approval on.
      const restarted = await call("instance_restart", { id: row!.id, reason: "android_ui 超时" });
      expect(restarted.isError).toBeFalsy();
      expect(restarted.content[0]!.text).toContain("已修复");
      expect(repairs).toEqual([{ id: row!.id, by: "agent", runId: "r1" }]);
      expect(asked).toHaveLength(1);

      expect(names).toContain("get_help");
      const help = await call("get_help", { problem: "android_ui 一直超时，重启也没用" });
      expect(help.content[0]!.text).toContain("维修员诊断");
      expect(helped).toEqual(["android_ui 一直超时，重启也没用"]);
    } finally {
      await client.close();
      await app.close();
    }
  });
});

describe("instance health and repair", () => {
  const FATAL = "FATAL        | A snapshot operation for 'constella' is pending and timeout has expired. Exiting...";

  /** fetch stand-in for the control service's /health. */
  async function withHealth<T>(ok: () => boolean, fn: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      ok() ? new Response(JSON.stringify({ ok: true, ready: true })) : new Response(JSON.stringify({ ok: false, ready: false, reason: "正在连接安卓设备" }), { status: 503 })) as any;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  it("removes only the lock files a killed emulator leaves behind", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "avd-"));
    for (const f of ["snapshot.lock.lock", "hardware-qemu.ini.lock", "multiinstance.lock", "snapshot.lock.tmp-z97Oxq", "userdata-qemu.img.qcow2", "config.ini"]) fs.writeFileSync(path.join(dir, f), "x");
    expect(clearStaleLocks(dir).sort()).toEqual(["hardware-qemu.ini.lock", "multiinstance.lock", "snapshot.lock.lock", "snapshot.lock.tmp-z97Oxq"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["config.ini", "userdata-qemu.img.qcow2"]);
    expect(clearStaleLocks(path.join(dir, "missing"))).toEqual([]);
  });

  it("tells a crash loop from a deliberately stopped instance, with the evidence", async () => {
    const containers = fakeContainers("running");
    const s = setup({ containers, caps: caps({ backend: "emulator" }) });
    const r = await s.desktops.create({ name: "安卓助手专用机", kind: "android" });
    containers.infos.set(`constella-android-${r.id}`, { state: "stopped", restarting: true, restartCount: 94, startedAt: new Date().toISOString() });
    containers.logLines.set(`constella-android-${r.id}`, `INFO | booting\n${FATAL}\n`);
    const h = await withHealth(() => false, () => s.desktops.diagnose(r.id));
    expect(h).toMatchObject({ ok: false, state: "broken", crashLoop: true });
    expect(h.problem).toContain("反复退出（Docker 已自动重启 94 次）");
    expect(h.problem).toContain("锁文件");
    expect(h.detail).toContain("正在连接安卓设备");
    expect(h.detail).toContain("snapshot operation");

    containers.states.set(`constella-desktop-${r.id}`, "stopped");
    containers.infos.set(`constella-android-${r.id}`, { state: "stopped" });
    expect(await withHealth(() => false, () => s.desktops.diagnose(r.id))).toMatchObject({ ok: true, state: "stopped" });
  });

  it("repairs by stopping properly, clearing stale locks and starting; recreates the containers when that isn't enough", async () => {
    const containers = fakeContainers("running");
    const s = setup({ containers, caps: caps({ backend: "emulator" }) });
    const r = await s.desktops.create({ name: "x", kind: "android" });
    const avd = path.join(config.desktopsDir, r.id, "avd", "constella.avd");
    fs.mkdirSync(avd, { recursive: true });
    fs.writeFileSync(path.join(avd, "snapshot.lock.lock"), "1");
    // Healthy again once it has been started.
    const res = await withHealth(() => containers.calls.includes(`ensure ${r.id}`), () => s.desktops.repair(r.id));
    expect(res.ok).toBe(true);
    expect(containers.calls).toEqual([`stop constella-desktop-${r.id}`, `stop constella-android-${r.id}`, `ensure ${r.id}`]);
    expect(res.steps.join("；")).toContain("snapshot.lock.lock");
    expect(fs.existsSync(path.join(avd, "snapshot.lock.lock"))).toBe(false);
    expect(s.db.prepare("SELECT 1 FROM audit WHERE action = 'instance.repair'").get()).toBeTruthy();
  }, 10_000);

  it("falls back to recreating the containers, and says so when even that fails", async () => {
    const containers = fakeContainers("running");
    const s = setup({ containers, caps: caps() });
    const r = await s.desktops.create({ name: "x", kind: "browser" });
    // Never healthy: both attempts time out (30 s each for a browser), so shorten the wait.
    const real = Date.now;
    let offset = 0;
    Date.now = () => real() + offset;
    const timer = setInterval(() => (offset += 10_000), 5);
    try {
      const res = await withHealth(() => false, () => s.desktops.repair(r.id));
      expect(res.ok).toBe(false);
      expect(containers.calls.filter((c) => c.startsWith("remove"))).toEqual([`remove constella-desktop-${r.id}`]);
      expect(containers.calls.filter((c) => c.startsWith("ensure"))).toHaveLength(2);
      expect(s.db.prepare("SELECT 1 FROM audit WHERE action = 'instance.repair_failed'").get()).toBeTruthy();
    } finally {
      clearInterval(timer);
      Date.now = real;
    }
  }, 20_000);
});

describe("instance operations in progress", () => {
  /** A promise the test settles by hand. */
  function gate<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  }

  async function withHealthy<T>(fn: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, ready: true }))) as any;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  it("shows what is being done, joins a repeated request and refuses a different one", async () => {
    const s = setup({ caps: caps() });
    const r = await s.desktops.create({ name: "浏览器", kind: "browser" });
    const g = gate();
    let runs = 0;
    const first = s.desktops.operate(r.id, "restarting", async () => (runs++, await g.promise));
    const again = s.desktops.operate(r.id, "restarting", async () => void runs++);
    expect(runs).toBe(1);
    expect(s.desktops.op(r.id)).toBe("restarting");
    expect((await s.desktops.list())[0]).toMatchObject({ op: "restarting", error: null });
    expect(() => s.desktops.operate(r.id, "stopping", async () => {})).toThrow(/正在重启/);
    expect(s.desktops.busy(r.id)).toBe(true);
    g.resolve();
    await Promise.all([first, again]);
    expect(runs).toBe(1);
    expect(s.desktops.op(r.id)).toBeNull();
    expect(s.desktops.busy(r.id)).toBe(false);
  });

  it("keeps a failure for an instance that isn't working, until it starts or the next operation begins", async () => {
    const containers = fakeContainers("running");
    const s = setup({ containers, caps: caps() });
    const up = await s.desktops.create({ name: "在线", kind: "browser" });
    const down = await s.desktops.create({ name: "离线", kind: "browser" });
    containers.states.set(`constella-desktop-${down.id}`, "stopped");

    await expect(s.desktops.operate(down.id, "starting", async () => Promise.reject(new Error("镜像不存在")), "owner")).rejects.toThrow("镜像不存在");
    expect(s.desktops.op(down.id)).toBeNull();
    expect((await s.desktops.get(down.id)).error).toMatchObject({ op: "starting", message: "镜像不存在" });
    expect(s.db.prepare("SELECT 1 FROM audit WHERE action = 'instance.op_failed'").get()).toBeTruthy();

    // A failure doesn't matter on an instance that is working.
    await expect(s.desktops.operate(up.id, "restarting", async () => Promise.reject(new Error("超时")))).rejects.toThrow("超时");
    expect((await s.desktops.get(up.id)).error).toBeNull();

    // Starting it successfully clears the failure.
    containers.states.set(`constella-desktop-${down.id}`, "running");
    await withHealthy(() => s.desktops.start(down.id));
    expect((await s.desktops.get(down.id)).error).toBeNull();
  });

  it("starts the next operation from a clean slate", async () => {
    const containers = fakeContainers("stopped");
    const s = setup({ containers, caps: caps() });
    const r = await s.desktops.create({ name: "x", kind: "browser" });
    await expect(s.desktops.operate(r.id, "starting", async () => Promise.reject(new Error("失败")))).rejects.toThrow("失败");
    const g = gate();
    const job = s.desktops.operate(r.id, "stopping", () => g.promise);
    expect((await s.desktops.get(r.id)).error).toBeNull();
    g.resolve();
    await job;
  });

  it("reports a start from anywhere as starting, and clears an earlier failure once it works", async () => {
    const containers = fakeContainers("stopped");
    const g = gate();
    containers.ensureDesktop = async (spec: { desktopId: string }) => {
      containers.calls.push(`ensure ${spec.desktopId}`);
      await g.promise;
      containers.states.set(`constella-desktop-${spec.desktopId}`, "running");
    };
    const s = setup({ containers, caps: caps() });
    const r = await s.desktops.create({ name: "浏览器", kind: "browser" });
    await withHealthy(async () => {
      const job = s.desktops.start(r.id);
      expect(s.desktops.op(r.id)).toBe("starting");
      g.resolve();
      await job;
    });
    expect(s.desktops.op(r.id)).toBeNull();
    expect((await s.desktops.get(r.id)).state).toBe("running");
  });

  it("shares one container-state read between lists in quick succession, and re-reads after a change", async () => {
    const containers = fakeContainers("running");
    let reads = 0;
    const read = containers.state;
    containers.state = async (name: string) => (reads++, read(name));
    const s = setup({ containers, caps: caps() });
    await s.desktops.create({ name: "a", kind: "browser" });
    await s.desktops.list();
    await s.desktops.list();
    await Promise.all([s.desktops.list(), s.desktops.get(s.desktops.rows()[0]!.id)]);
    expect(reads).toBe(1);
    const id = s.desktops.rows()[0]!.id;
    await s.desktops.operate(id, "pausing", async () => s.desktops.pause(id));
    expect((await s.desktops.get(id)).state).toBe("paused");
    expect(reads).toBeGreaterThan(1);
  });

  it("saves changed options at once and restarts in the background when asked to", async () => {
    const containers = fakeContainers("running");
    const g = gate();
    const stop = containers.stop;
    containers.stop = async (name: string) => (await g.promise, stop(name));
    const s = setup({ containers, caps: caps() });
    const r = await s.desktops.create({ name: "x", kind: "browser" });
    await withHealthy(async () => {
      const out = await s.desktops.update(r.id, { options: { width: 1440, height: 900 } }, { background: true });
      expect(out).toEqual({ restarted: true, wiped: false });
      // Saved, and the restart is still waiting on the container to stop.
      expect(s.desktops.options(s.desktops.row(r.id))).toMatchObject({ width: 1440, height: 900 });
      expect(s.desktops.op(r.id)).toBe("restarting");
      g.resolve();
      await vi.waitFor(() => expect(s.desktops.op(r.id)).toBeNull());
    });
    expect(containers.calls).toContain(`ensure ${r.id}`);
  });

  it("only resets Android", async () => {
    const s = setup({ caps: caps() });
    const b = await s.desktops.create({ name: "浏览器", kind: "browser" });
    await expect(s.desktops.reset(b.id, "owner")).rejects.toThrow(DesktopError);
    expect(s.desktops.op(b.id)).toBeNull();
  });
});
