import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentInput, TEMPLATES } from "./agents.ts";
import type { Hub } from "./app.ts";
import { EffortSchema } from "./catalog.ts";
import { config, nowIso } from "./config.ts";
import { audit, kvSet } from "./db.ts";
import type { DesktopAction } from "./desktops.ts";
import { isTrusted } from "./trusted.ts";
import { loadUsage, rangeStart, usageStats } from "./usage.ts";
import { contextBreakdown } from "./context.ts";
import { ScheduleInput } from "./scheduler.ts";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    sessionId?: string;
  }
}

const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\/(status|setup|login|passkey\/login\/(options|verify))$/, /^\/api\/runner/, /^\/api\/desktops\/[^/]+\/vnc$/];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function registerRoutes(hub: Hub): void {
  const { app, auth, agents, runs, recovery, events, desktops, knowledge, learning, reflect, scheduler, notifier, newapi, models, catalog, settings, containers, db } = hub;

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err?.validation || err instanceof z.ZodError ? 400 : (err?.statusCode ?? 400);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；") : (err?.message ?? "error");
    if (status >= 500) console.error(err);
    reply.code(status).send({ error: message, code: err?.code });
  });

  // Auth + CSRF guard for the JSON API.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    if (!url.startsWith("/api/")) return;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !url.startsWith("/api/runner")) {
      if (req.headers["x-constella"] !== "1") return reply.code(403).send({ error: "missing X-Constella header" });
      const origin = req.headers.origin;
      if (origin && !config.origins.includes(origin) && !isTrusted(req)) return reply.code(403).send({ error: "origin not allowed" });
    }
    if (PUBLIC.some((r) => r.test(url))) return;
    const s = auth.check(req);
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    req.userId = s.userId;
    req.sessionId = s.sessionId;
  });

  const actor = (req: FastifyRequest) => req.userId ?? "anonymous";
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  // ── health & auth ────────────────────────────────────────
  app.get("/api/health", async () => ({ ok: true, time: nowIso() }));

  app.get("/api/auth/status", async (req) => ({
    setupNeeded: auth.needsSetup(),
    loggedIn: !!auth.check(req),
    totp: !!auth.user()?.totp_secret,
    passkeyRpIds: [...new Set((auth.passkeys() as { rp_id: string }[]).map((p) => p.rp_id))],
  }));
  app.post("/api/auth/setup", authLimit, async (req, reply) => {
    const b = z.object({ code: z.string(), name: z.string().min(1).max(40), password: z.string() }).parse(req.body);
    const user = auth.setup(b.code, b.name, b.password);
    auth.createSession(user.id, req, reply);
    return { ok: true };
  });
  app.post("/api/auth/login", authLimit, async (req, reply) => {
    const b = z.object({ password: z.string(), totp: z.string().optional() }).parse(req.body);
    try {
      const user = auth.loginPassword(b.password, b.totp);
      auth.createSession(user.id, req, reply);
      return { ok: true };
    } catch (err: any) {
      throw new HttpError(err.code === "TOTP_REQUIRED" ? 409 : 401, err.message);
    }
  });
  app.post("/api/auth/passkey/login/options", authLimit, async (req) => auth.passkeyLoginOptions(req.headers.origin));
  app.post("/api/auth/passkey/login/verify", authLimit, async (req, reply) => {
    const b = z.object({ key: z.string(), response: z.any() }).parse(req.body);
    const user = await auth.passkeyLoginVerify(req.headers.origin, b.key, b.response).catch((e) => {
      throw new HttpError(401, e.message);
    });
    auth.createSession(user.id, req, reply);
    return { ok: true };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(req.sessionId!, reply);
    return { ok: true };
  });
  app.get("/api/me", async (req) => {
    const u = auth.user()!;
    return { id: u.id, name: u.name, totp: !!u.totp_secret, passkeys: auth.passkeys(), sessions: auth.sessions(req.sessionId!) };
  });
  app.post("/api/auth/passkey/register/options", async (req) => auth.passkeyRegisterOptions(req.headers.origin));
  app.post("/api/auth/passkey/register/verify", async (req) => {
    const b = z.object({ key: z.string(), response: z.any(), name: z.string().max(40).default("通行密钥") }).parse(req.body);
    await auth.passkeyRegisterVerify(req.headers.origin, b.key, b.response, b.name);
    return { ok: true };
  });
  app.delete("/api/auth/passkeys/:id", async (req) => {
    auth.deletePasskey((req.params as { id: string }).id);
    audit(db, actor(req), "auth.passkey.delete");
    return { ok: true };
  });
  app.post("/api/auth/password", async (req) => {
    const b = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    auth.changePassword(b.current, b.next);
    return { ok: true };
  });
  app.post("/api/auth/totp/begin", async () => auth.totpBegin());
  app.post("/api/auth/totp/enable", async (req) => {
    const b = z.object({ secret: z.string(), code: z.string() }).parse(req.body);
    auth.totpEnable(b.secret, b.code);
    return { ok: true };
  });
  app.post("/api/auth/totp/disable", async (req) => {
    auth.totpDisable(z.object({ password: z.string() }).parse(req.body).password);
    return { ok: true };
  });
  app.delete("/api/auth/sessions/:id", async (req) => {
    auth.revokeSession((req.params as { id: string }).id);
    audit(db, actor(req), "auth.session.revoke");
    return { ok: true };
  });

  // ── overview & stream ────────────────────────────────────
  app.get("/api/overview", async () => {
    const list = agents.list();
    const agentViews = await Promise.all(list.map((a) => agentView(hub, a.id)));
    const approvals = pendingApprovals();
    const conversations = db
      .prepare(
        `SELECT c.*, a.name AS agent_name, a.emoji AS agent_emoji,
           (SELECT status FROM runs r WHERE r.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_status
         FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE a.archived = 0 ORDER BY c.updated_at DESC LIMIT 30`,
      )
      .all();
    const unread = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").get() as { n: number }).n;
    return { agents: agentViews, approvals, conversations, desktops: await desktops.list(), unread, incidents: incidentViews(recovery.list({ status: "open", limit: 20 })) };
  });

  app.get("/api/stream", async (req, reply) => {
    const q = req.query as { cursor?: string };
    const last = Number(req.headers["last-event-id"] ?? q.cursor ?? NaN);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (m: any) => {
      if (m.kind === "event") res.write(`id: ${m.cursor}\nevent: agent\ndata: ${JSON.stringify({ conversationId: m.conversationId, event: m.event })}\n\n`);
      else res.write(`event: hub\ndata: ${JSON.stringify({ type: m.type, data: m.data })}\n\n`);
    };
    if (Number.isFinite(last)) for (const m of events.since(last)) write({ kind: "event", ...m });
    else res.write(`id: ${events.latestCursor()}\nevent: ready\ndata: {}\n\n`);
    events.bus.on("message", write);
    const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      events.bus.off("message", write);
    });
  });

  // ── agents ───────────────────────────────────────────────
  app.get("/api/templates", async () => TEMPLATES);
  app.get("/api/agents", async () => Promise.all(agents.list().map((a) => agentView(hub, a.id))));
  /** A model ref must point at an existing provider before anything is saved with it. */
  const checkModel = (ref: string | null | undefined) => {
    if (ref) models.resolve(ref);
  };
  app.post("/api/agents", async (req) => {
    const input = AgentInput.parse(req.body);
    checkModel(input.model);
    const a = agents.create(input, actor(req));
    events.publish("agent", { id: a.id });
    return agentView(hub, a.id);
  });
  app.get("/api/agents/:id", async (req) => agentView(hub, id(req)));
  app.patch("/api/agents/:id", async (req) => {
    checkModel((req.body as { model?: string })?.model);
    agents.update(id(req), req.body as any, actor(req));
    events.publish("agent", { id: id(req) });
    return agentView(hub, id(req));
  });
  app.delete("/api/agents/:id", async (req) => {
    const agentId = id(req);
    agents.archive(agentId, actor(req));
    await containers.remove(containers.agentName(agentId)).catch(() => {});
    events.publish("agent", { id: agentId, removed: true });
    return { ok: true };
  });
  app.post("/api/agents/:id/restart", async (req) => {
    const agentId = id(req);
    await containers.remove(containers.agentName(agentId));
    events.publish("agent", { id: agentId, connected: false });
    return { ok: true };
  });
  app.get("/api/agents/:id/export", async (req, reply) => {
    const data = agents.exportAgent(id(req));
    reply.header("Content-Disposition", `attachment; filename="agent-${id(req)}.json"`);
    return data;
  });
  app.post("/api/agents/import", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const a = agents.importAgent(req.body, actor(req));
    // Exported from another instance: its provider may not exist here.
    if (!models.provider(models.parse(a.model).provider)) agents.update(a.id, { model: settings.defaultModel() }, actor(req));
    events.publish("agent", { id: a.id });
    return agentView(hub, a.id);
  });
  app.get("/api/agents/:id/secrets", async (req) => agents.userSecretNames(id(req)));
  app.put("/api/agents/:id/secrets/:name", async (req) => {
    const p = req.params as { id: string; name: string };
    agents.setSecret(p.id, p.name, z.object({ value: z.string().min(1).max(10000) }).parse(req.body).value, actor(req));
    return { ok: true, note: "重启 agent 后生效" };
  });
  app.delete("/api/agents/:id/secrets/:name", async (req) => {
    const p = req.params as { id: string; name: string };
    agents.deleteSecret(p.id, p.name, actor(req));
    return { ok: true };
  });
  app.post("/api/agents/:id/newapi-token", async (req) => {
    const agentId = id(req);
    const a = agents.get(agentId);
    const quota = z.object({ quotaUsd: z.number().positive().nullable().default(null) }).parse(req.body ?? {}).quotaUsd;
    if (a.newapi_token_id) await newapi.deleteToken(a.newapi_token_id).catch(() => {});
    const t = await newapi.createToken(`constella-${agentId}`, quota);
    agents.setNewApiToken(agentId, t.id, t.key);
    audit(db, actor(req), "agent.newapi_token", { id: agentId, tokenId: t.id });
    await containers.remove(containers.agentName(agentId)).catch(() => {});
    return { ok: true, tokenId: t.id };
  });
  app.post("/api/agents/:id/uploads", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const b = z.object({ name: z.string().max(120), data: z.string() }).parse(req.body);
    const safe = b.name.replace(/[^\w.\-一-龥]/g, "_").slice(-80) || "file";
    const rel = path.join("uploads", `${Date.now()}-${safe}`);
    const abs = path.join(config.agentsDir, id(req), "workspace", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b.data, "base64"));
    try {
      fs.chownSync(abs, 1000, 1000);
      fs.chownSync(path.dirname(abs), 1000, 1000);
    } catch {}
    return { path: `/workspace/${rel}`, image: /\.(png|jpe?g|gif|webp)$/i.test(safe) };
  });

  // ── conversations & runs ─────────────────────────────────
  app.get("/api/agents/:id/conversations", async (req) =>
    db
      .prepare(
        `SELECT c.*, (SELECT status FROM runs r WHERE r.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_status
         FROM conversations c WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(id(req)),
  );
  const ModelPatch = {
    model: z.string().min(1).max(200).nullable().optional(),
    effort: EffortSchema.nullable().optional(),
  };
  const SendBody = z.object({ text: z.string().min(1).max(20000), images: z.array(z.string()).max(8).optional(), ...ModelPatch });
  app.post("/api/agents/:id/messages", async (req) => {
    const b = SendBody.parse(req.body);
    await checkBudget(hub, id(req));
    return runs.send({ agentId: id(req), text: b.text, images: b.images, model: b.model, effort: b.effort });
  });
  app.get("/api/agents/:id/today", async (req) => {
    const a = agents.get(id(req));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const totals = db
      .prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM runs WHERE agent_id = ? AND created_at >= ?")
      .get(a.id, start.toISOString()) as { runs: number; input: number; output: number };
    let spentUsd: number | null = null;
    if (a.newapi_token_id && newapi.adminEnabled()) {
      const spend = await newapi.spendByToken(Math.floor(start.getTime() / 1000)).catch(() => null);
      spentUsd = spend ? (spend[`constella-${a.id}`] ?? 0) : null;
    }
    return { ...totals, spentUsd, budgetUsd: a.budget_daily_usd };
  });
  app.get("/api/conversations/:id", async (req) => {
    const conv = runs.conversation(id(req));
    if (!conv) throw new HttpError(404, "conversation not found");
    const runRows = db.prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at").all(conv.id) as any[];
    return {
      conversation: conv,
      runs: runRows.map((r) => ({ ...r, events: events.forRun(r.id) })),
      approvals: (db.prepare("SELECT * FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?) AND status = 'pending'").all(conv.id) as any[]).map(approvalView),
      incidents: recovery.list({ conversationId: conv.id, limit: 200 }),
    };
  });
  app.get("/api/conversations/:id/context", async (req) => {
    const conv = runs.conversation(id(req));
    if (!conv) throw new HttpError(404, "conversation not found");
    const a = agents.get(conv.agent_id);
    const memory = knowledge.memory(a.id);
    const memoryText = [memory.user, memory.agent].join("\n");
    const runRows = db.prepare("SELECT id, prompt FROM runs WHERE conversation_id = ? ORDER BY created_at").all(conv.id) as { id: string; prompt: string }[];
    return (
      contextBreakdown({
        persona: agents.instructions(a, { desktopNote: "" }).replace(memory.user.trim(), "").replace(memory.agent.trim(), ""),
        memory: memoryText,
        skills: knowledge
          .skills(a.id)
          .map((s) => `${s.name}: ${s.description}`)
          .join("\n"),
        runs: runRows.map((r) => ({ prompt: r.prompt, events: events.forRun(r.id) })),
      }) ?? { used: 0, window: null, parts: [], measured: false }
    );
  });
  app.patch("/api/conversations/:id", async (req) => {
    const b = z.object({ title: z.string().min(1).max(60).optional(), ...ModelPatch }).parse(req.body);
    checkModel(b.model);
    if (b.title) db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(b.title, id(req));
    if (b.model !== undefined || b.effort !== undefined) runs.setConversationModel(id(req), b);
    return { ok: true };
  });
  app.delete("/api/conversations/:id", async (req) => {
    const conv = runs.conversation(id(req));
    if (!conv) return { ok: true };
    const active = runs.activeRun(conv.id);
    if (active) await runs.interrupt(active.id, actor(req));
    db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(conv.id);
    db.prepare("DELETE FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(conv.id);
    db.prepare("DELETE FROM runs WHERE conversation_id = ?").run(conv.id);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(conv.id);
    return { ok: true };
  });
  app.post("/api/conversations/:id/messages", async (req) => {
    const conv = runs.conversation(id(req));
    if (!conv) throw new HttpError(404, "conversation not found");
    const b = SendBody.parse(req.body);
    await checkBudget(hub, conv.agent_id);
    return runs.send({ agentId: conv.agent_id, conversationId: conv.id, text: b.text, images: b.images, model: b.model, effort: b.effort });
  });
  app.post("/api/runs/:id/interrupt", async (req) => {
    await runs.interrupt(id(req), actor(req));
    return { ok: true };
  });
  app.post("/api/runs/:id/feedback", async (req) => {
    const b = z.object({ value: z.union([z.literal(1), z.literal(-1)]) }).parse(req.body);
    const run = runs.setFeedback(id(req), b.value);
    if (run && ["done", "failed"].includes(run.status)) learning.maybeReflect(run);
    return { ok: true };
  });

  // ── reflect ──────────────────────────────────────────────
  const ReflectQuery = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) });
  app.get("/api/reflect", async (req) => {
    const { days } = ReflectQuery.parse(req.query);
    return { stats: reflect.stats(days), summary: reflect.cached(days) };
  });
  app.post("/api/reflect/summary", async (req) => {
    const { days } = ReflectQuery.parse(req.query);
    return { summary: await reflect.summarize(days) };
  });

  // ── approvals (and the agents' multiple-choice questions) ─
  const pendingApprovals = () =>
    (
      db
        .prepare(
          `SELECT ap.*, r.conversation_id, a.name AS agent_name, a.emoji AS agent_emoji FROM approvals ap JOIN runs r ON r.id = ap.run_id
           JOIN agents a ON a.id = ap.agent_id WHERE ap.status = 'pending' ORDER BY ap.created_at`,
        )
        .all() as any[]
    ).map(approvalView);
  app.get("/api/approvals", async () => pendingApprovals());
  app.post("/api/approvals/:id", async (req) => {
    const b = z.object({ decision: z.enum(["approve", "deny"]), answer: z.string().max(2000).optional() }).parse(req.body);
    await runs.resolveApproval(id(req), b.decision, actor(req), "user", b.answer);
    return { ok: true };
  });

  // ── incidents (diagnosis reports, supervisor interventions) ─
  const incidentViews = (list: ReturnType<typeof recovery.list>) => {
    const names = new Map(agents.list(true).map((a) => [a.id, a]));
    return list.map((i) => ({ ...i, agent_name: names.get(i.agent_id ?? "")?.name ?? null, agent_emoji: names.get(i.agent_id ?? "")?.emoji ?? null }));
  };
  app.get("/api/incidents", async (req) => {
    const q = z
      .object({ status: z.enum(["open", "all"]).default("all"), conversationId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    return incidentViews(recovery.list(q));
  });
  app.get("/api/incidents/:id", async (req) => {
    const inc = recovery.get(id(req));
    if (!inc) throw new HttpError(404, "报告不存在");
    return incidentViews([inc])[0];
  });
  app.post("/api/incidents/:id/adopt", async (req) => {
    const b = z.object({ index: z.number().int().min(0) }).parse(req.body);
    return recovery.adopt(id(req), b.index, actor(req));
  });
  app.post("/api/incidents/:id/dismiss", async (req) => recovery.dismiss(id(req), actor(req)));

  // ── desktops ─────────────────────────────────────────────
  app.get("/api/desktops", async () => desktops.list());
  app.post("/api/desktops", async (req) => {
    const b = z.object({ name: z.string().min(1).max(40), pinnedAgentId: z.string().nullable().optional() }).parse(req.body);
    const d = desktops.create(b.name, b.pinnedAgentId ?? null);
    audit(db, actor(req), "desktop.create", { id: d.id });
    return d;
  });
  app.patch("/api/desktops/:id", async (req) => {
    desktops.rename(id(req), z.object({ name: z.string().min(1).max(40) }).parse(req.body).name);
    return { ok: true };
  });
  app.delete("/api/desktops/:id", async (req) => {
    const pinned = agents.list().filter((a) => {
      const p = JSON.parse(a.desktop_policy);
      return p.mode === "fixed" && p.desktopId === id(req);
    });
    if (pinned.length) throw new HttpError(409, `先修改这些 agent 的桌面设置：${pinned.map((a) => a.name).join("、")}`);
    await desktops.remove(id(req));
    audit(db, actor(req), "desktop.delete", { id: id(req) });
    return { ok: true };
  });
  app.post("/api/desktops/:id/start", async (req) => {
    await desktops.start(id(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/stop", async (req) => {
    if (desktops.lease(id(req)).holder !== "none") throw new HttpError(409, "桌面正在使用中");
    await desktops.stop(id(req));
    return { ok: true };
  });
  app.get("/api/desktops/:id/screenshot", async (req, reply) => {
    const w = Number((req.query as { width?: string }).width ?? 480);
    const shot = await desktops.screenshot(id(req), { width: Math.min(Math.max(w, 160), 1280), quality: 60 });
    reply.header("Content-Type", "image/jpeg").header("Cache-Control", "no-store");
    return reply.send(shot.data);
  });
  app.post("/api/desktops/:id/takeover", async (req) => {
    desktops.takeover(id(req), actor(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/handback", async (req) => {
    const b = z.object({ note: z.string().max(300).default("") }).parse(req.body ?? {});
    desktops.handback(id(req), b.note, actor(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/clipboard", async (req) => {
    if (desktops.lease(id(req)).holder !== "human") throw new HttpError(409, "请先接管桌面");
    const b = z.object({ text: z.string().max(20000) }).parse(req.body);
    await desktops.clipboard(id(req), b.text);
    return { ok: true };
  });
  app.post("/api/desktops/:id/ticket", async (req) => {
    desktops.row(id(req));
    return { ticket: auth.issueTicket("vnc", { desktopId: id(req), userId: req.userId }) };
  });
  app.get("/api/desktops/:id/vnc", { websocket: true }, (socket, req) => {
    const ticket = String((req.query as { ticket?: string }).ticket ?? "");
    const data = auth.consumeTicket<{ desktopId: string }>(ticket, "vnc");
    const desktopId = (req.params as { id: string }).id;
    if (!data || data.desktopId !== desktopId) {
      socket.close(4001, "invalid ticket");
      return;
    }
    desktops.bridgeVnc(socket, desktopId, () => {
      try {
        return desktops.lease(desktopId).holder === "human";
      } catch {
        return false;
      }
    });
  });

  // ── knowledge & learning ─────────────────────────────────
  app.get("/api/agents/:id/knowledge", async (req) => ({ memory: knowledge.memory(id(req)), skills: knowledge.skills(id(req)) }));
  app.put("/api/agents/:id/memory", async (req) => {
    const b = z.object({ scope: z.enum(["agent", "user"]), content: z.string().max(12000) }).parse(req.body);
    return { event: knowledge.writeMemory(id(req), b.scope, b.content, "用户") };
  });
  app.get("/api/agents/:id/skills/:name", async (req) => {
    const p = req.params as { id: string; name: string };
    return { content: knowledge.skillBody(p.id, p.name) };
  });
  app.delete("/api/agents/:id/skills/:name", async (req) => {
    const p = req.params as { id: string; name: string };
    const scope = (req.query as { scope?: string }).scope;
    return { event: knowledge.deleteSkill(scope === "shared" ? null : p.id, p.name, "用户") };
  });
  app.post("/api/agents/:id/skills/:name/promote", async (req) => {
    const p = req.params as { id: string; name: string };
    return { event: knowledge.promote(p.id, p.name) };
  });
  app.get("/api/learning", async (req) => {
    const q = req.query as { agentId?: string; limit?: string };
    const rows = knowledge.events({ agentId: q.agentId, limit: Number(q.limit ?? 100) }) as any[];
    const names = new Map(agents.list(true).map((a) => [a.id, { name: a.name, emoji: a.emoji }]));
    return rows.map((r) => ({ ...r, agent: r.agent_id ? names.get(r.agent_id) : null }));
  });
  app.get("/api/learning/:id/diff", async (req) => ({ diff: knowledge.diff(id(req)) }));
  app.post("/api/learning/:id/revert", async (req) => {
    knowledge.revert(id(req), actor(req));
    return { ok: true };
  });
  app.post("/api/agents/:id/curate", async (req) => ({ events: await learning.curate(id(req)) }));
  app.post("/api/agents/:id/memory/instruct", async (req) => {
    const b = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    agents.get(id(req));
    return learning.instruct(id(req), b.text);
  });
  app.post("/api/agents/:id/memory/delete", async (req) => {
    const b = z.object({ scope: z.enum(["agent", "user"]), item: z.string().min(1).max(400) }).parse(req.body);
    return { events: knowledge.apply(id(req), { memory: [{ op: "delete", scope: b.scope, match: b.item.slice(0, 200) }] }, { runId: null, reason: "用户删除" }) };
  });
  app.post("/api/runs/:id/reflect", async (req) => {
    db.prepare("UPDATE runs SET reflected = 0 WHERE id = ?").run(id(req));
    return { events: await learning.reflect(id(req)) };
  });

  // ── schedules ────────────────────────────────────────────
  app.get("/api/schedules", async () =>
    scheduler.list().map((s) => ({ ...s, payload: JSON.parse(s.payload), next_run: scheduler.nextRun(s.id), last: (scheduler.history(s.id, 1) as any[])[0] ?? null })),
  );
  app.post("/api/schedules", async (req) => scheduler.create(req.body as ScheduleInput, actor(req)));
  app.patch("/api/schedules/:id", async (req) => scheduler.update(id(req), req.body as any, actor(req)));
  app.delete("/api/schedules/:id", async (req) => {
    scheduler.remove(id(req), actor(req));
    return { ok: true };
  });
  app.post("/api/schedules/:id/run", async (req) => scheduler.fire(id(req)));
  app.get("/api/schedules/:id/history", async (req) => scheduler.history(id(req)));

  // ── models & providers ───────────────────────────────────
  app.get("/api/models", async () => {
    await models.seed();
    // Each entry also carries the reasoning levels its model supports (keyed by model name, as Codex reports it).
    return models.list().map((m) => ({ ...m, ...catalog.get(m.model) }));
  });
  app.post("/api/models", async (req) => {
    const b = z.object({ provider: z.string(), models: z.array(z.string().trim().min(1).max(200)).min(1).max(500) }).parse(req.body);
    const added = models.add(b.provider, b.models);
    audit(db, actor(req), "models.add", { provider: b.provider, count: added });
    return { added };
  });
  app.patch("/api/models", async (req) => {
    const b = z.object({ ref: z.string(), bare: z.boolean() }).parse(req.body);
    models.setBare(b.ref, b.bare);
    return { ok: true };
  });
  app.delete("/api/models", async (req) => {
    const ref = z.object({ ref: z.string() }).parse(req.query).ref;
    models.remove(ref);
    audit(db, actor(req), "models.remove", { ref });
    return { ok: true };
  });
  app.post("/api/models/test", async (req) => models.test(z.object({ ref: z.string() }).parse(req.body).ref));

  const providerView = () =>
    models.providers().map((p) => {
      const key = models.apiKey(p.id);
      return { ...p, keyHint: key ? `…${key.slice(-4)}` : null, models: models.list().filter((m) => m.provider === p.id).length };
    });
  const ProviderBody = z.object({ name: z.string().trim().min(1).max(40), baseUrl: z.string().trim().min(1).max(300), apiKey: z.string().trim().max(500).default("") });
  app.get("/api/providers", async () => providerView());
  app.post("/api/providers", async (req) => {
    const p = models.addProvider(ProviderBody.parse(req.body));
    audit(db, actor(req), "provider.create", { id: p.id, name: p.name });
    return p;
  });
  app.patch("/api/providers/:id", async (req) => {
    const p = models.updateProvider(id(req), ProviderBody.partial().parse(req.body));
    audit(db, actor(req), "provider.update", { id: p.id });
    return p;
  });
  app.delete("/api/providers/:id", async (req) => {
    const users = models.usersOf(id(req), [settings.defaultModel(), settings.reflectModel()]);
    if (users.length) throw new HttpError(409, `还有 ${users.join("、")} 在用这个 provider 的模型，先换掉再删除`);
    models.removeProvider(id(req));
    audit(db, actor(req), "provider.delete", { id: id(req) });
    return { ok: true };
  });
  app.get("/api/providers/:id/models", async (req) => models.remoteModels(id(req)));
  app.post("/api/providers/:id/test", async (req) => {
    const started = Date.now();
    try {
      const list = await models.remoteModels(id(req));
      return { ok: true, models: list.length, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
    }
  });

  // ── usage & settings ─────────────────────────────────────
  app.get("/api/usage", async (req) => {
    const days = Math.min(Number((req.query as { days?: string }).days ?? 7), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = db
      .prepare(
        `SELECT agent_id, substr(created_at, 1, 10) AS day, model, COUNT(*) AS runs, SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens FROM runs WHERE created_at >= ? GROUP BY agent_id, day, model ORDER BY day`,
      )
      .all(since);
    let spend: Record<string, number> | null = null;
    if (newapi.adminEnabled()) {
      spend = await newapi.spendByToken(Math.floor(Date.parse(since) / 1000)).catch(() => null);
    }
    const perAgent = spend
      ? Object.fromEntries(agents.list(true).map((a) => [a.id, spend![`constella-${a.id}`] ?? 0]))
      : null;
    return { rows, spendUsd: perAgent, adminEnabled: newapi.adminEnabled() };
  });
  app.get("/api/usage/stats", async (req) => {
    const q = z
      .object({ range: z.enum(["today", "7d", "30d"]).default("today"), agent: z.string().optional(), model: z.string().optional(), provider: z.string().optional() })
      .parse(req.query);
    const since = rangeStart(q.range);
    const { events: all, runs: runInfo } = loadUsage(db, since, { agentId: q.agent }, (ref) => models.normalize(ref));
    const events = all.filter((e) => (!q.model || e.model === q.model) && (!q.provider || models.parse(e.model).provider === q.provider));
    const stats = usageStats(events, runInfo, q.range);
    let spend: Record<string, number> | null = null;
    if (newapi.adminEnabled()) spend = await newapi.spendByToken(Math.floor(Date.parse(since) / 1000)).catch(() => null);
    const list = agents.list(true);
    const providers = models.providers();
    const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? `${id}（已删除）`;
    const byProvider = new Map<string, { provider: string; name: string; requests: number; input: number; cached: number; output: number; models: number }>();
    for (const m of stats.models) {
      const pid = models.parse(m.model).provider;
      const t = byProvider.get(pid) ?? { provider: pid, name: providerName(pid), requests: 0, input: 0, cached: 0, output: 0, models: 0 };
      t.requests += m.requests;
      t.input += m.input;
      t.cached += m.cached;
      t.output += m.output;
      t.models++;
      byProvider.set(pid, t);
    }
    const labels = new Map<string, string>();
    const label = (ref: string) => labels.get(ref) ?? labels.set(ref, models.label(ref)).get(ref)!;
    const withLabel = <T extends { model: string }>(x: T) => {
      const pid = models.parse(x.model).provider;
      return { ...x, label: label(x.model), provider: pid, providerName: providerName(pid) };
    };
    // Spend comes from per-agent new-api tokens, so it only adds up when not narrowed to a model or another provider.
    const spendTotal = spend && !q.model && (!q.provider || q.provider === "newapi");
    return {
      ...stats,
      models: stats.models.map(withLabel),
      log: stats.log.map(withLabel),
      providers: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
      agents: stats.agents.map((a) => {
        const ag = list.find((x) => x.id === a.agentId);
        return { ...a, name: ag?.name ?? "已删除", emoji: ag?.emoji ?? "·", spendUsd: spend ? (spend[`constella-${a.agentId}`] ?? 0) : null };
      }),
      spendUsd: spendTotal ? list.filter((a) => !q.agent || a.id === q.agent).reduce((n, a) => n + (spend![`constella-${a.id}`] ?? 0), 0) : null,
      filters: {
        models: [...new Set(all.map((e) => e.model))].map((ref) => ({ ref, label: label(ref) })).sort((a, b) => a.label.localeCompare(b.label)),
        providers: [...new Set(all.map((e) => models.parse(e.model).provider))].map((id) => ({ id, name: providerName(id) })),
        agents: list.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji })),
      },
    };
  });
  app.get("/api/settings", async () => settings.view());
  const minutes = (allowed: number[]) => z.number().int().refine((v) => allowed.includes(v), `只能是 ${allowed.join(" / ")}`);
  const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式是 HH:MM");
  const SettingsPatch = z.object({
    defaultModel: z.string().min(1).optional(),
    reflectModel: z.string().min(1).optional(),
    defaultEffort: EffortSchema.nullable().optional(),
    newapiAdminToken: z.string().optional(),
    newapiAdminUserId: z.string().optional(),
    telegramBotToken: z.string().optional(),
    telegramChatId: z.string().optional(),
    autoResume: z.boolean().optional(),
    browserHtml: z.boolean().optional(),
    maxAutoResumes: z.number().int().min(1).max(10).optional(),
    runTimeoutMinutes: minutes([30, 60, 120, 240, 480]).optional(),
    runWatchdogMinutes: minutes([0, 5, 10, 20, 30, 60]).optional(),
    approvalMode: z.enum(["ask", "smart", "auto"]).optional(),
    agentIdleMinutes: minutes([0, 10, 30, 60, 120, 360]).optional(),
    desktopIdleMinutes: minutes([0, 10, 30, 60, 120, 360]).optional(),
    autoReflect: z.boolean().optional(),
    reflectMinToolCalls: z.number().int().min(1).max(50).optional(),
    notifyOn: z.object({ done: z.boolean(), failed: z.boolean(), approval: z.boolean(), stuck: z.boolean() }).partial().optional(),
    quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).partial().optional(),
    backupKeep: z.number().int().min(1).max(60).optional(),
    modelNameFormat: z.enum(["paren", "dash"]).optional(),
  });
  app.patch("/api/settings", async (req) => {
    const b = SettingsPatch.parse(req.body);
    checkModel(b.defaultModel);
    checkModel(b.reflectModel);
    const set = (key: string, v: unknown) => v !== undefined && kvSet(db, `settings.${key}`, String(v));
    for (const key of ["approvalMode", "autoResume", "browserHtml", "maxAutoResumes", "runTimeoutMinutes", "runWatchdogMinutes", "agentIdleMinutes", "desktopIdleMinutes", "autoReflect", "reflectMinToolCalls", "backupKeep", "modelNameFormat"] as const)
      set(key, b[key]);
    if (b.defaultModel) kvSet(db, "settings.defaultModel", b.defaultModel);
    if (b.reflectModel) kvSet(db, "settings.reflectModel", b.reflectModel);
    if (b.defaultEffort !== undefined) kvSet(db, "settings.defaultEffort", b.defaultEffort ?? "");
    for (const [k, v] of Object.entries(b.notifyOn ?? {})) set(`notify.${k}`, v);
    for (const [k, v] of Object.entries(b.quietHours ?? {})) set(`quiet.${k}`, v);
    if (b.newapiAdminToken !== undefined) b.newapiAdminToken ? hub.secrets.set("settings", "newapiAdminToken", b.newapiAdminToken) : hub.secrets.delete("settings", "newapiAdminToken");
    if (b.newapiAdminUserId) kvSet(db, "settings.newapiAdminUserId", b.newapiAdminUserId);
    if (b.telegramBotToken !== undefined) b.telegramBotToken ? hub.secrets.set("settings", "telegramBotToken", b.telegramBotToken) : hub.secrets.delete("settings", "telegramBotToken");
    if (b.telegramChatId !== undefined) kvSet(db, "settings.telegramChatId", b.telegramChatId);
    audit(db, actor(req), "settings.update", { fields: Object.keys(b) });
    return settings.view();
  });

  // ── notifications ────────────────────────────────────────
  app.get("/api/push/key", async () => ({ publicKey: notifier.publicKey }));
  app.post("/api/push/subscribe", async (req) => {
    const b = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), device: z.string().max(80).default("手机") }).parse(req.body);
    notifier.subscribe(b, b.device);
    return { ok: true };
  });
  app.post("/api/push/unsubscribe", async (req) => {
    notifier.unsubscribe(z.object({ endpoint: z.string() }).parse(req.body).endpoint);
    return { ok: true };
  });
  app.get("/api/push/devices", async () => notifier.subscriptions());
  app.post("/api/push/test", async () => notifier.send("Constella 测试通知", "推送通道工作正常 ✓", "/settings"));
  app.get("/api/notifications", async () => notifier.inbox());
  app.post("/api/notifications/read", async () => {
    notifier.markRead();
    return { ok: true };
  });

  // ── system ───────────────────────────────────────────────
  app.get("/api/system", async () => {
    const stat = fs.statfsSync(config.dataDir);
    const backups = fs.existsSync(config.backupsDir)
      ? fs
          .readdirSync(config.backupsDir)
          .filter((f) => f.startsWith("constella-"))
          .sort()
          .reverse()
          .map((f) => ({ name: f, size: fs.statSync(path.join(config.backupsDir, f)).size }))
      : [];
    const containerList = await containers.docker.listContainers({ all: true, filters: { label: ["dev.constella.role"] } }).catch(() => []);
    return {
      disk: { freeGb: +((stat.bavail * stat.bsize) / 1e9).toFixed(1), totalGb: +((stat.blocks * stat.bsize) / 1e9).toFixed(1) },
      dbSizeMb: +(fs.statSync(config.dbPath).size / 1e6).toFixed(1),
      containers: containerList.map((c) => ({ name: c.Names[0]?.slice(1), state: c.State, status: c.Status, role: c.Labels["dev.constella.role"] })),
      backups,
      newapi: await models
        .remoteModels("newapi")
        .then((m) => ({ ok: true, models: m.length }))
        .catch((e) => ({ ok: false, error: e.message })),
      version: "0.1.0",
    };
  });
  app.post("/api/system/backup", async () => ({ file: path.basename(await hub.backup()) }));
  app.get("/api/audit", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(300), before: z.coerce.number().int().optional() }).parse(req.query);
    return q.before
      ? db.prepare("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?").all(q.before, q.limit)
      : db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(q.limit);
  });
}

/** Approval rows with a question's options parsed. */
function approvalView(row: Record<string, any>) {
  return { ...row, options: row.options ? JSON.parse(row.options) : null };
}

function id(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

async function agentView(hub: Hub, agentId: string) {
  const a = hub.agents.get(agentId);
  const state = await hub.containers.state(hub.containers.agentName(a.id)).catch(() => "error");
  const active = hub.db
    .prepare("SELECT id, status, conversation_id FROM runs WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled') ORDER BY created_at DESC")
    .all(a.id);
  const { token_hash, ...rest } = a;
  void token_hash;
  return {
    ...rest,
    desktop_policy: JSON.parse(a.desktop_policy),
    host_access: !!a.host_access,
    container: state,
    connected: hub.runners.connected(a.id),
    activeRuns: active,
    secrets: hub.agents.userSecretNames(a.id),
  };
}

/** Refuse new work once an agent's dedicated new-api token has spent its daily budget. */
async function checkBudget(hub: Hub, agentId: string): Promise<void> {
  const a = hub.agents.get(agentId);
  if (!a.budget_daily_usd || !a.newapi_token_id || !hub.newapi.adminEnabled()) return;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const spend = await hub.newapi.spendByToken(Math.floor(start.getTime() / 1000)).catch(() => null);
  const used = spend?.[`constella-${agentId}`] ?? 0;
  if (used >= a.budget_daily_usd) throw new HttpError(402, `今日预算已用完（$${used.toFixed(2)} / $${a.budget_daily_usd}）`);
}

export type { FastifyReply, DesktopAction };
