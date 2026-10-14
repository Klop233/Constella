import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-recovery-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CONSTELLA_RUN_WATCHDOG_MINUTES = "10";

const { openDb } = await import("../src/db.ts");
const { EventStore } = await import("../src/events.ts");
const { RunManager, ANSWER_PREFIX, ADOPT_PREFIX } = await import("../src/runs.ts");
const { Recovery, killable, parseDiagnosis, parsePs, MAX_INTERVENTIONS } = await import("../src/recovery.ts");

const tick = (ms = 10) => new Promise((res) => setTimeout(res, ms));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Db = ReturnType<typeof openDb>;

function setup(opts: { resume?: boolean; ensureRunner?: () => Promise<void>; repair?: (a: string, e: string) => Promise<string[]>; delays?: number[] } = {}) {
  const db: Db = openDb(":memory:");
  db.prepare(
    `INSERT INTO agents (id, name, emoji, template, persona, model, approval_policy, desktop_policy, token_hash, created_at, updated_at)
     VALUES ('ag1', '助理', '✨', 'assistant', 'p', 'm', 'auto', '{"mode":"none"}', 'h', 'now', 'now')`,
  ).run();
  const sent: any[] = [];
  const notes: string[] = [];
  const incidents: any[] = [];
  const events = new EventStore(db);
  const runs = new RunManager({
    db,
    events,
    ensureRunner: opts.ensureRunner ?? (async () => {}),
    sendToRunner: (_a, msg) => {
      sent.push(msg);
      return true;
    },
    startPayload: () => ({ model: "m", instructions: "i", approvalPolicy: "auto", skillRoots: [] }),
    notify: (t) => notes.push(t),
    autoResume: () => opts.resume ?? true,
    approvalMode: () => "ask",
    repairRunner: opts.repair,
    incident: (i) => incidents.push(i),
    resumeDelaysMs: opts.delays ?? [0, 0, 0],
  });
  const starts = () => sent.filter((m) => m.t === "start");
  return { db, runs, events, sent, notes, incidents, starts };
}

/** A tool call that completed successfully: what counts as progress. */
function progress(runs: InstanceType<typeof RunManager>, runId: string) {
  runs.onRunnerEvent("ag1", { type: "tool.started", runId, callId: `c-${runId}`, name: "shell", input: { command: "ls" } });
  runs.onRunnerEvent("ag1", { type: "tool.completed", runId, callId: `c-${runId}`, ok: true });
}

describe("automatic continuation", () => {
  it("keeps continuing while each turn gets something done, and stops after three idle ones", async () => {
    const t = setup();
    const r = await t.runs.send({ agentId: "ag1", text: "长任务" });
    await tick();
    // Five cut-offs, each after real work: never stops.
    let current = r.runId;
    for (let i = 0; i < 5; i++) {
      progress(t.runs, current);
      t.runs.onRunnerHello("ag1", []);
      await tick();
      const next = t.starts().at(-1);
      expect(next.runId).not.toBe(current);
      expect(next.text.startsWith("［自动继续］")).toBe(true);
      current = next.runId;
    }
    // Now three cut-offs in a row with nothing done: two more tries, then it stops and files an incident.
    for (let i = 0; i < 3; i++) {
      t.runs.onRunnerHello("ag1", []);
      await tick();
    }
    const before = t.starts().length;
    t.runs.onRunnerHello("ag1", []);
    await tick();
    expect(t.starts().length).toBe(before);
    expect(t.incidents.at(-1)).toMatchObject({ kind: "stalled", conversationId: r.conversationId });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'run.auto_resume_stalled'").get()).toMatchObject({ n: 1 });
    // Cut-offs that get continued don't push "task failed" notifications.
    expect(t.notes.filter((n) => n.includes("任务失败"))).toHaveLength(0);
  });

  it("keeps scheduled continuations in the database so a restart doesn't lose them", async () => {
    const t = setup({ delays: [60_000] });
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    t.runs.onRunnerHello("ag1", []);
    expect(t.db.prepare("SELECT status FROM resumes").get()).toMatchObject({ status: "scheduled" });
    expect(t.starts()).toHaveLength(1);
    // "Restart": a fresh manager on the same database, after the due time.
    t.db.prepare("UPDATE resumes SET due_at = ?").run(minutesAgo(1));
    const sent: any[] = [];
    const again = new RunManager({
      db: t.db,
      events: t.events,
      ensureRunner: async () => {},
      sendToRunner: (_a, msg) => {
        sent.push(msg);
        return true;
      },
      startPayload: () => ({ model: "m", instructions: "i", approvalPolicy: "auto", skillRoots: [] }),
      notify: () => {},
      autoResume: () => true,
    });
    again.processResumes();
    again.processResumes(); // claimed once, started once
    await tick();
    expect(sent.filter((m) => m.t === "start")).toHaveLength(1);
    expect(sent[0]).toMatchObject({ conversationId: r.conversationId });
    expect(t.db.prepare("SELECT status FROM resumes").get()).toMatchObject({ status: "started" });
  });

  it("skips a continuation when the owner already sent something", async () => {
    const t = setup({ delays: [60_000] });
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    t.runs.onRunnerHello("ag1", []);
    await t.runs.send({ agentId: "ag1", conversationId: r.conversationId, text: "我自己来接着说" });
    t.db.prepare("UPDATE resumes SET due_at = ?").run(minutesAgo(1));
    t.runs.processResumes();
    expect(t.db.prepare("SELECT status FROM resumes").get()).toMatchObject({ status: "skipped" });
  });

  it("splits a long turn and continues it once the stop lands", async () => {
    const t = setup();
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    progress(t.runs, r.runId);
    await t.runs.restart(r.runId, "单轮运行超过 120 分钟", "［自动继续］继续", "watchdog");
    await t.runs.restart(r.runId, "单轮运行超过 120 分钟", "［自动继续］继续", "watchdog"); // the next tick: no second stop
    expect(t.sent.filter((m) => m.t === "interrupt")).toHaveLength(1);
    t.runs.engineDone(r.runId, "cancelled");
    await tick();
    expect(t.starts().at(-1)).toMatchObject({ text: "［自动继续］继续" });
  });
});

describe("single-turn time limit", () => {
  const stops = (t: ReturnType<typeof setup>) => t.sent.filter((m) => m.t === "interrupt").length;
  /** A turn that started `minutes` ago in a conversation with the given own limit (null = follow the setting). */
  async function turn(t: ReturnType<typeof setup>, minutes: number, own: number | null) {
    const r = await t.runs.send({ agentId: "ag1", text: "x", runTimeoutMinutes: own });
    await tick();
    t.db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(minutesAgo(minutes), r.runId);
    return r;
  }

  it("follows the setting (120 minutes here) unless the conversation has its own", async () => {
    const t = setup();
    await turn(t, 100, null);
    t.runs.tick();
    expect(stops(t)).toBe(0);
    t.db.prepare("UPDATE runs SET created_at = ?").run(minutesAgo(130));
    t.runs.tick();
    expect(stops(t)).toBe(1);
  });

  it("stops a turn at the conversation's own, shorter limit", async () => {
    const t = setup();
    await turn(t, 40, 30);
    t.runs.tick();
    expect(stops(t)).toBe(1);
  });

  it("lets a conversation with no limit run as long as it needs", async () => {
    const t = setup();
    const r = await turn(t, 24 * 60, 0);
    t.runs.tick();
    expect(stops(t)).toBe(0);
    expect(t.runs.conversation(r.conversationId)!.run_timeout_minutes).toBe(0);
    // Back to following the setting: now it is overdue.
    t.runs.setConversationTimeout(r.conversationId, null);
    t.runs.tick();
    expect(stops(t)).toBe(1);
  });
});

describe("start failures", () => {
  it("repairs the runner and carries on with the same run", async () => {
    let fail = true;
    const repaired: string[] = [];
    const t = setup({
      ensureRunner: async () => {
        if (fail) throw new Error("agent 容器启动超时");
      },
      repair: async (agentId) => {
        repaired.push(agentId);
        fail = false;
        return ["删除了旧容器", "重新创建了容器"];
      },
    });
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    expect(repaired).toEqual(["ag1"]);
    expect(t.runs.get(r.runId)!.status).toBe("running");
    expect(t.starts()).toHaveLength(1);
    const actions = (t.db.prepare("SELECT action FROM audit ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["runner.start_failed", "runner.repaired"]));
    expect(t.incidents[0]).toMatchObject({ kind: "start_failure", resolved: true });
    expect(t.events.forRun(r.runId).some((e) => e.type === "system.notice" && e.kind === "recovery")).toBe(true);
  });

  it("when the repair doesn't help, fails the run and sends the original request again later", async () => {
    const t = setup({
      delays: [60_000],
      ensureRunner: async () => {
        throw new Error("no such image");
      },
      repair: async () => {
        throw new Error("no such image");
      },
    });
    const r = await t.runs.send({ agentId: "ag1", text: "帮我查天气" });
    await tick();
    expect(t.runs.get(r.runId)).toMatchObject({ status: "failed" });
    expect(t.runs.get(r.runId)!.error).toContain("自动修复后仍失败");
    expect(t.db.prepare("SELECT text FROM resumes").get()).toMatchObject({ text: "［自动继续］帮我查天气" });
    expect(t.db.prepare("SELECT 1 FROM audit WHERE action = 'runner.repair_failed'").get()).toBeTruthy();
  });
});

describe("engine errors", () => {
  it("files an incident for errors that aren't temporary instead of retrying", async () => {
    const t = setup();
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    t.runs.engineDone(r.runId, "failed", "context window exceeded");
    await tick();
    expect(t.starts()).toHaveLength(1);
    expect(t.incidents).toEqual([expect.objectContaining({ kind: "engine_error", runId: r.runId, error: "context window exceeded" })]);
    expect(t.notes.filter((n) => n.includes("任务失败"))).toHaveLength(0);
  });
});

describe("questions to the owner", () => {
  it("waits for a pick, and takes typed text as the answer", async () => {
    const t = setup();
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    const opts = [{ label: "用 A" }, { label: "用 B" }];
    const q1 = t.runs.requestDecision(r.runId, "用哪个？", opts, 0, 60_000);
    expect(t.runs.get(r.runId)!.status).toBe("waiting_approval");
    expect(t.notes.at(-1)).toContain("需要你选择");
    const ap = t.db.prepare("SELECT id, options FROM approvals WHERE kind = 'decision'").get() as { id: string; options: string };
    expect(JSON.parse(ap.options)).toEqual(opts);
    await t.runs.resolveApproval(ap.id, "approve", "user", "user", "用 B");
    await expect(q1).resolves.toEqual({ status: "answered", answer: "用 B" });
    expect(t.runs.get(r.runId)!.status).toBe("running");

    const q2 = t.runs.requestDecision(r.runId, "几点？", [{ label: "8 点" }, { label: "9 点" }], undefined, 60_000);
    const s = await t.runs.send({ agentId: "ag1", conversationId: r.conversationId, text: "十点吧" });
    expect(s.steered).toBe(true);
    await expect(q2).resolves.toEqual({ status: "answered", answer: "十点吧" });
  });

  it("stops waiting after the timeout, keeps the question open, and delivers a late answer as a message", async () => {
    const t = setup();
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    const q = t.runs.requestDecision(r.runId, "用哪个？", [{ label: "A" }, { label: "B" }], 0, 20);
    await expect(q).resolves.toEqual({ status: "timeout" });
    expect(t.runs.get(r.runId)!.status).toBe("running");
    t.runs.engineDone(r.runId, "done");
    const ap = t.db.prepare("SELECT id, status FROM approvals WHERE kind = 'decision'").get() as { id: string; status: string };
    expect(ap.status).toBe("pending");
    await t.runs.resolveApproval(ap.id, "approve", "user", "user", "B");
    await tick();
    expect(t.starts().at(-1).text).toBe(`${ANSWER_PREFIX}用哪个？\n→ B`);
  });

  it("expires open questions when the owner stops the task", async () => {
    const t = setup();
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    void t.runs.requestDecision(r.runId, "?", [{ label: "A" }, { label: "B" }], undefined, 60_000);
    await t.runs.interrupt(r.runId, "user");
    t.runs.engineDone(r.runId, "cancelled");
    expect(t.db.prepare("SELECT status FROM approvals").get()).toMatchObject({ status: "expired" });
  });
});

describe("recovery helpers", () => {
  it("accepts only valid diagnosis options", () => {
    const raw = {
      title: "上下文超长",
      cause: "对话太长了",
      options: [
        { title: "换模型", action: "switch_model", model: "nope", text: "x" },
        { title: "换成 big", action: "switch_model", model: "big", text: "继续" },
        { title: "删库", action: "rm_rf" },
        { title: "重新开始", action: "new_thread", text: "任务是…" },
      ],
      recommended: 1,
    };
    const d = parseDiagnosis(raw, ["m", "big"], "m")!;
    expect(d.options.map((o) => o.title)).toEqual(["换成 big", "重新开始"]);
    expect(d.recommended).toBe(1);
    expect(parseDiagnosis({ title: "x", cause: "y", options: [{ title: "a", action: "stop" }] }, [], "m")).toBeNull();
  });

  it("only lets the supervisor stop commands the engine started", () => {
    const procs = parsePs(`    PID    PPID ELAPSED STAT %CPU COMMAND
      1       0    1101 Ssl   0.0 node /opt/constella/runner/src/index.ts
     19       1    1100 Sl    0.0 node /usr/local/bin/codex app-server
     26      19    1100 Sl    0.4 /usr/local/lib/codex-linux-x64/bin/codex app-server
    300      26     700 S     0.0 /bin/bash -lc npm init
    301     300     700 S     0.0 npm init
    400       1     900 S     0.0 python3 -m http.server`);
    expect(procs).toHaveLength(6);
    expect(killable(procs, [1, 19, 26, 300, 301, 400, 999])).toEqual([300, 301]);
  });
});

describe("incidents and the supervisor", () => {
  function withRecovery(verdict: unknown, t = setup()) {
    const execs: string[][] = [];
    const removed: string[] = [];
    const recovery = new Recovery({
      db: t.db,
      events: t.events,
      runs: t.runs,
      agents: { get: () => ({ id: "ag1", name: "助理", model: "m" }) } as any,
      containers: {
        agentName: (id: string) => `constella-agent-${id}`,
        state: async () => "running",
        logs: async () => "",
        remove: async (n: string) => void removed.push(n),
        exec: async (_n: string, cmd: string[]) => {
          execs.push(cmd);
          return {
            exitCode: 0,
            output: `PID PPID ELAPSED STAT %CPU COMMAND
 26 1 900 Sl 0.1 codex app-server
 300 26 700 S 0.0 /bin/bash -lc npm init`,
          };
        },
      } as any,
      llm: {
        list: () => [{ ref: "m" }, { ref: "big" }],
        chatJson: async () => {
          if (verdict instanceof Error) throw verdict;
          return verdict;
        },
      } as any,
      model: () => "judge",
      notify: (t2: string) => t.notes.push(t2),
      ensureRunner: async () => {},
      connected: () => true,
      secretValues: () => [],
    });
    return { ...t, recovery, execs, removed };
  }

  async function stuckRun(t: ReturnType<typeof setup>, command = "npm init") {
    const r = await t.runs.send({ agentId: "ag1", text: "初始化项目" });
    await tick();
    t.runs.onRunnerEvent("ag1", { type: "tool.started", runId: r.runId, callId: "c1", name: "shell", input: { command } });
    t.db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ?").run(minutesAgo(12), r.runId);
    return r;
  }

  it("diagnoses an engine error and carries out the option the owner adopts", async () => {
    const t = withRecovery({
      title: "模型不支持图片",
      cause: "当前模型不接受图片输入",
      options: [
        { title: "换成 big", detail: "big 支持图片", action: "switch_model", model: "big", text: "换了模型，继续" },
        { title: "跳过图片", action: "continue", text: "不看图片继续" },
      ],
      recommended: 0,
    });
    const r = await t.runs.send({ agentId: "ag1", text: "看图" });
    await tick();
    const inc = t.recovery.file({ kind: "engine_error", agentId: "ag1", conversationId: r.conversationId, runId: r.runId, error: "image input not supported" });
    expect(inc.status).toBe("analyzing");
    const done = await t.recovery.diagnose(inc.id);
    expect(done).toMatchObject({ status: "open", title: "模型不支持图片", recommended: 0 });
    expect(t.notes.at(-1)).toContain("模型不支持图片");
    t.runs.engineDone(r.runId, "failed", "image input not supported");
    const adopted = await t.recovery.adopt(inc.id, 0, "user");
    expect(adopted).toMatchObject({ status: "adopted", resolution: "换成 big" });
    expect(t.runs.conversation(r.conversationId)!.model).toBe("big");
    await tick();
    expect(t.starts().at(-1)).toMatchObject({ model: "big", text: `${ADOPT_PREFIX}换成 big\n换了模型，继续` });
    await expect(t.recovery.adopt(inc.id, 1, "user")).rejects.toThrow("已经处理过");
  });

  it("falls back to generic options when the diagnosis model is unavailable", async () => {
    const t = withRecovery(new Error("502 bad gateway"));
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    const inc = t.recovery.file({ kind: "stalled", agentId: "ag1", conversationId: r.conversationId, runId: r.runId, error: "boom" });
    const done = (await t.recovery.diagnose(inc.id))!;
    expect(done.status).toBe("open");
    expect(done.options.map((o) => o.action)).toEqual(["continue", "switch_model", "restart_agent", "new_thread"]);
    await t.recovery.adopt(inc.id, 3, "user");
    expect(t.runs.conversation(r.conversationId)!.thread_id).toBeNull();
  });

  it("stops a stuck command, records it, and leaves runs that wait on the owner alone", async () => {
    const t = withRecovery({ assessment: "npm init 在等交互输入", action: "kill", pids: [300, 26], text: "改用 npm init -y" });
    const r = await stuckRun(t);
    await t.recovery.checkStuck();
    expect(t.execs.some((c) => c.join(" ") === "kill -TERM 300")).toBe(true);
    expect(t.sent.at(-1)).toMatchObject({ t: "steer", text: "［监督员］改用 npm init -y" });
    const run = t.runs.get(r.runId)!;
    expect(run.interventions).toBe(1);
    expect(Date.parse(run.check_after!)).toBeGreaterThan(Date.now());
    expect(t.db.prepare("SELECT 1 FROM audit WHERE actor = 'supervisor' AND action = 'supervisor.kill'").get()).toBeTruthy();
    expect(t.recovery.list()[0]).toMatchObject({ kind: "stuck", status: "auto" });
    expect(t.events.forRun(r.runId).some((e) => e.type === "system.notice" && e.kind === "supervisor")).toBe(true);

    // A run waiting for the owner to hand the desktop back isn't stuck.
    const w = withRecovery({ assessment: "?", action: "restart" });
    const r2 = await stuckRun(w);
    w.runs.onRunnerEvent("ag1", { type: "tool.started", runId: r2.runId, callId: "c2", name: "constella.desktop_request_help", input: {} });
    w.db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ?").run(minutesAgo(12), r2.runId);
    await w.recovery.checkStuck();
    expect(w.runs.get(r2.runId)!.interventions).toBe(0);
    expect(w.sent.some((m) => m.t === "interrupt")).toBe(false);
  });

  it("restarts the turn when the judge is unavailable, then asks the owner after the limit", async () => {
    const t = withRecovery(new Error("timeout"));
    const r = await stuckRun(t);
    await t.recovery.checkStuck();
    expect(t.sent.some((m) => m.t === "interrupt" && m.runId === r.runId)).toBe(true);
    expect(t.db.prepare("SELECT status FROM resumes WHERE run_id = ?").get(r.runId)).toMatchObject({ status: "on_cancel" });

    const r2 = await stuckRun(t);
    t.db.prepare("UPDATE runs SET interventions = ? WHERE id = ?").run(MAX_INTERVENTIONS, r2.runId);
    await t.recovery.checkStuck();
    const open = t.recovery.list({ status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "stuck", run_id: r2.runId });
    expect(open[0]!.options.map((o) => o.action)).toEqual(["restart", "wait", "stop"]);
    // Adopting "wait" gives the supervisor a fresh budget later.
    await t.recovery.adopt(open[0]!.id, 1, "user");
    expect(t.runs.get(r2.runId)!.interventions).toBe(0);
  });

  it("climbs the ladder: a restart that didn't help means rebuilding the container, then asking the owner", async () => {
    const t = withRecovery({ assessment: "?", action: "wait" });
    const r = await stuckRun(t);
    // The supervisor restarted this turn; the stop lands as the runner goes away (cut-off), and the promised continuation follows.
    await t.runs.restart(r.runId, "监督员：卡住", "［自动继续］上次任务因为卡住（监督员重启了这一轮）中断了，请从中断的地方继续完成。", "supervisor");
    t.runs.onRunnerHello("ag1", []);
    await tick();
    const next = t.starts().at(-1);
    expect(next.text).toContain("监督员重启了这一轮");
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM resumes WHERE status != 'skipped'").get()).toMatchObject({ n: 1 });
    // The continuation hangs too: no model needed, the container gets rebuilt.
    t.db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ?").run(minutesAgo(12), next.runId);
    await t.recovery.checkStuck();
    expect(t.removed).toEqual(["constella-agent-ag1"]);
    expect(t.db.prepare("SELECT 1 FROM audit WHERE action = 'supervisor.rebuild'").get()).toBeTruthy();
    t.runs.engineDone(next.runId, "cancelled");
    await tick();
    const after = t.starts().at(-1);
    expect(after.text).toContain("监督员重建了 agent 容器");
    // Still stuck after the rebuild: the owner decides.
    t.db.prepare("UPDATE runs SET last_event_at = ? WHERE id = ?").run(minutesAgo(12), after.runId);
    await t.recovery.checkStuck();
    expect(t.recovery.list({ status: "open" })[0]).toMatchObject({ kind: "stuck", run_id: after.runId });
  });

  it("closes open reports once later work in the conversation succeeds", async () => {
    const t = withRecovery({ title: "x", cause: "y", options: [{ title: "继续", action: "continue", text: "go" }] });
    const r = await t.runs.send({ agentId: "ag1", text: "x" });
    await tick();
    t.runs.engineDone(r.runId, "failed", "weird");
    const inc = t.recovery.file({ kind: "engine_error", agentId: "ag1", conversationId: r.conversationId, runId: r.runId, error: "weird" });
    await t.recovery.diagnose(inc.id);
    await tick(5);
    const r2 = await t.runs.send({ agentId: "ag1", conversationId: r.conversationId, text: "我换个说法" });
    await tick();
    t.runs.engineDone(r2.runId, "done");
    expect(t.recovery.get(inc.id)).toMatchObject({ status: "auto", resolution: "后续任务已完成" });
  });
});
