import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DesktopKind, DesktopOptions, IdleAction } from "@constella/protocol";
import { z } from "zod";
import { AgentInput, TEMPLATES } from "./agents.ts";
import { isArchiveName, listArchive } from "./archive.ts";
import { OFFICE_CONTAINER, OFFICE_PREFIX, officeDocType } from "./office.ts";
import { MAX_ARTIFACT_TEXT, type ArtifactVersionRow } from "./artifacts.ts";
import type { Hub } from "./app.ts";
import { EffortSchema } from "./catalog.ts";
import { config, nowIso } from "./config.ts";
import { auditRefs, changesOf } from "./audit.ts";
import { describeDevice } from "./auth.ts";
import { audit, kvSet } from "./db.ts";
import { DesktopError, type DesktopAction } from "./desktops.ts";
import { requestSource } from "./request-source.ts";
import { isTrusted } from "./trusted.ts";
import { loadUsage, rangeStart, usageStats } from "./usage.ts";
import { groupOf, PERF_INTERVAL_S, type PerfGroup, type PerfRange } from "./perf.ts";
import { contextBreakdown } from "./context.ts";
import { ScheduleInput } from "./scheduler.ts";
import { IMPORT_TEXT_MAX } from "./learning.ts";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    sessionId?: string;
  }
}

const OFFICE_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const PUBLIC = [/^\/api\/office\/(file|callback)\//, /^\/api\/health$/, /^\/api\/auth\/(status|setup|login|passkey\/login\/(options|verify))$/, /^\/api\/runner/, /^\/api\/desktops\/[^/]+\/vnc$/];

const DESKTOP_STATUS: Record<string, number> = { not_found: 404, busy: 409, limit: 409, unavailable: 409, confirm: 409 };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function registerRoutes(hub: Hub): void {
  const { office, app, auth, agents, runs, artifacts, recovery, events, desktops, knowledge, learning, reflect, scheduler, notifier, newapi, models, catalog, settings, containers, db } = hub;

  app.setErrorHandler((err: any, _req, reply) => {
    const status =
      err instanceof HttpError
        ? err.status
        : err instanceof DesktopError
          ? (DESKTOP_STATUS[err.code] ?? 400)
          : err?.validation || err instanceof z.ZodError
            ? 400
            : (err?.statusCode ?? 400);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；") : (err?.message ?? "error");
    if (status >= 500) console.error(err);
    reply.code(status).send({ error: message, code: err?.code });
  });

  // Audit entries written while handling a request record where it came from (not for the runner's own connection).
  app.addHook("onRequest", (req, _reply, done) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/runner")) return done();
    requestSource.run({ ip: req.ip, device: describeDevice(String(req.headers["user-agent"] ?? "")) }, done);
  });

  // Auth + CSRF guard for the JSON API.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    if (!url.startsWith("/api/")) return;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !url.startsWith("/api/runner") && !url.startsWith("/api/office/callback/")) {
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
    const key = (auth.passkeys() as { id: string; name: string; rp_id: string }[]).find((p) => p.id === (req.params as { id: string }).id);
    auth.deletePasskey((req.params as { id: string }).id);
    audit(db, actor(req), "auth.passkey.delete", key ? { name: key.name, rpID: key.rp_id } : undefined);
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
    const prefix = (req.params as { id: string }).id;
    const target = (auth.sessions(req.sessionId!) as { id: string; device: string; ip: string | null }[]).find((s) => s.id === prefix);
    auth.revokeSession(prefix);
    audit(db, actor(req), "auth.session.revoke", target ? { device: target.device, deviceIp: target.ip } : undefined);
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
         FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE a.archived = 0 AND c.archived_at IS NULL ORDER BY c.updated_at DESC LIMIT 30`,
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
  app.get("/api/agents/:id/conversations", async (req) => {
    const archived = (req.query as { archived?: string }).archived === "1";
    return db
      .prepare(
        `SELECT c.*, (SELECT status FROM runs r WHERE r.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_status
         FROM conversations c WHERE agent_id = ? AND archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(id(req));
  });
  const RUN_TIMEOUTS = [0, 30, 60, 120, 240, 480];
  const ModelPatch = {
    model: z.string().min(1).max(200).nullable().optional(),
    effort: EffortSchema.nullable().optional(),
    /** This conversation's single-turn time limit: minutes, 0 for none, null to follow the setting. */
    runTimeoutMinutes: z.number().int().refine((v) => RUN_TIMEOUTS.includes(v), `只能是 ${RUN_TIMEOUTS.join(" / ")}`).nullable().optional(),
  };
  const SendBody = z.object({ text: z.string().min(1).max(20000), images: z.array(z.string()).max(8).optional(), ...ModelPatch });
  app.post("/api/agents/:id/messages", async (req) => {
    const b = SendBody.parse(req.body);
    await checkBudget(hub, id(req));
    return runs.send({ agentId: id(req), text: b.text, images: b.images, model: b.model, effort: b.effort, runTimeoutMinutes: b.runTimeoutMinutes });
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
    const b = z.object({ title: z.string().min(1).max(60).optional(), archived: z.boolean().optional(), ...ModelPatch }).parse(req.body);
    checkModel(b.model);
    if (b.archived !== undefined) db.prepare("UPDATE conversations SET archived_at = ? WHERE id = ?").run(b.archived ? new Date().toISOString() : null, id(req));
    if (b.title) db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(b.title, id(req));
    if (b.model !== undefined || b.effort !== undefined) runs.setConversationModel(id(req), b);
    if (b.runTimeoutMinutes !== undefined) runs.setConversationTimeout(id(req), b.runTimeoutMinutes);
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
    return runs.send({ agentId: conv.agent_id, conversationId: conv.id, text: b.text, images: b.images, model: b.model, effort: b.effort, runTimeoutMinutes: b.runTimeoutMinutes });
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

  // ── artifacts (files and documents agents delivered) ─────
  const artifactOr404 = (artifactId: string) => {
    const a = artifacts.get(artifactId);
    if (!a) throw new HttpError(404, "成果不存在或已删除");
    return a;
  };
  app.get("/api/artifacts", async (req) => {
    const q = z
      .object({
        agentId: z.string().optional(),
        conversationId: z.string().optional(),
        kinds: z.string().max(200).optional(),
        q: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    return artifacts.list({ ...q, kinds: q.kinds?.split(",").filter(Boolean) });
  });
  app.get("/api/artifacts/:id", async (req) => {
    const a = artifacts.item(id(req));
    if (!a) throw new HttpError(404, "成果不存在或已删除");
    return { ...a, versions: artifacts.versions(a.id) };
  });
  const VersionQuery = z.object({ v: z.coerce.number().int().min(1).optional(), download: z.enum(["0", "1"]).optional() });
  app.get("/api/artifacts/:id/content", async (req) => {
    const a = artifactOr404(id(req));
    return artifacts.text(a.id, VersionQuery.parse(req.query).v);
  });
  // What is inside a compressed file (zip, rar, 7z, tar.* …), listed without extracting.
  app.get("/api/artifacts/:id/archive", async (req, reply) => {
    const q = VersionQuery.parse(req.query);
    const a = artifactOr404(id(req));
    const v = artifacts.version(a.id, q.v);
    if (v.kind !== "file" || !isArchiveName(v.filename)) throw new HttpError(400, "这不是压缩包");
    const listing = await listArchive(artifacts.filePath(a.id, v.version), v.filename).catch((err) => {
      throw new HttpError(422, err instanceof Error ? err.message : String(err));
    });
    reply.header("Cache-Control", q.v ? "private, max-age=31536000, immutable" : "private, no-cache");
    return listing;
  });
  // Online Office editor (optional OnlyOffice container): the config the editor page needs for one version.
  app.get("/api/artifacts/:id/office", async (req) => {
    const q = VersionQuery.parse(req.query);
    const a = artifactOr404(id(req));
    const v = artifacts.version(a.id, q.v);
    const docType = v.kind === "file" ? officeDocType(v.filename) : null;
    if (!docType) throw new HttpError(400, "这不是 Word / Excel / PowerPoint 文件");
    if (!office.enabled()) return { enabled: false };
    try {
      await office.ensureRunning();
    } catch (err) {
      throw new HttpError(503, err instanceof Error ? err.message : String(err));
    }
    const latest = v.version === a.version;
    const token = office.sign({ a: a.id, v: v.version });
    const ext = v.filename.split(".").pop()!.toLowerCase();
    const cfg = {
      documentType: docType,
      document: {
        fileType: ext,
        key: `${a.id}-${v.version}`.slice(0, 120),
        title: v.filename,
        url: `${config.hubInternalUrl}/api/office/file/${token}`,
        permissions: { edit: latest, download: true, print: true },
      },
      editorConfig: {
        mode: latest ? "edit" : "view",
        lang: "zh-CN",
        callbackUrl: `${config.hubInternalUrl}/api/office/callback/${token}`,
        user: { id: req.userId ?? "owner", name: "我" },
        customization: { forcesave: true, autosave: false, compactHeader: true, toolbarNoTabs: false, hideRightMenu: true },
      },
      height: "100%",
      width: "100%",
    };
    return { enabled: true, editable: latest, apiUrl: `${OFFICE_PREFIX}/web-apps/apps/api/documents/api.js`, config: { ...cfg, token: office.jwtSign(cfg) } };
  });
  // The Document Server fetches the file and posts saves with a signed link (no session cookie).
  app.get("/api/office/file/:token", async (req, reply) => {
    const t = office.verify(String((req.params as { token: string }).token));
    if (!t) throw new HttpError(403, "链接无效或已过期");
    const v = artifacts.version(t.a, t.v);
    const file = artifacts.filePath(t.a, v.version);
    office.touch();
    return reply.header("Content-Type", "application/octet-stream").header("Content-Length", fs.statSync(file).size).send(fs.createReadStream(file));
  });
  app.post("/api/office/callback/:token", async (req) => {
    const t = office.verify(String((req.params as { token: string }).token));
    if (!t) throw new HttpError(403, "链接无效或已过期");
    let body = (req.body ?? {}) as Record<string, any>;
    // With JWT on, the real payload is signed: in the body's token, or in the Authorization header.
    const raw = typeof body.token === "string" ? body.token : String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const signed = raw ? office.jwtVerify(raw) : null;
    if (!signed) throw new HttpError(403, "签名无效");
    body = (signed.payload as Record<string, any>) ?? signed;
    office.touch();
    // 2: closed after edits, 6: saved on request. Anything else needs no action.
    if ((body.status === 2 || body.status === 6) && typeof body.url === "string") {
      try {
        // The URL names the Document Server as the browser sees it; fetch it from inside the network.
        const u = new URL(body.url);
        const res = await fetch(`http://${OFFICE_CONTAINER}${u.pathname.replace(OFFICE_PREFIX, "")}${u.search}`, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`下载保存结果失败（${res.status}）`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const cur = artifacts.get(t.a);
        if (cur && bytes.length > 0) {
          const newExt = (/\.([a-z0-9]+)$/i.exec(u.pathname)?.[1] ?? "").toLowerCase();
          const oldExt = (/\.([a-z0-9]+)$/i.exec(cur.filename)?.[1] ?? "").toLowerCase();
          const same = createHash("sha256").update(bytes).digest("hex") === artifacts.version(cur.id).sha256;
          // Old binary formats come back in their modern format; the artifact then continues under that name.
          const modern = ["docx", "xlsx", "pptx"].includes(newExt) && newExt !== oldExt && ["doc", "xls", "ppt"].includes(oldExt);
          if (!same) {
            const saved = artifacts.saveFile({
              artifactId: cur.id,
              bytes,
              note: body.status === 6 ? "在线编辑器保存" : "在线编辑",
              author: "user",
              ...(modern ? { filename: cur.filename.replace(/\.[^.]+$/, `.${newExt}`), mime: OFFICE_MIME[newExt] } : {}),
            });
            audit(db, "owner", "artifact.edit", { id: saved.id, version: saved.version });
          }
        }
      } catch (err) {
        console.error("office callback", err);
        return { error: 1 };
      }
    }
    return { error: 0 };
  });

  // Managing the optional editor service (Settings → System).
  app.get("/api/office/status", async () => office.status());
  const OfficePatch = z.object({ memoryMb: z.number().int().optional(), idleMinutes: z.number().int().optional() });
  app.patch("/api/office", async (req) => {
    const b = OfficePatch.parse(req.body);
    const before = { memoryMb: office.memoryMb(), idleMinutes: office.idleMinutes() };
    try {
      office.configure(b);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    // New limits apply at the next start.
    if (b.memoryMb !== undefined && b.memoryMb !== before.memoryMb) await office.stop().catch(() => {});
    audit(db, actor(req), "settings.update", { fields: Object.keys(b), changes: changesOf(before, { memoryMb: office.memoryMb(), idleMinutes: office.idleMinutes() }, Object.keys(b)) });
    return office.status();
  });
  app.post("/api/office/enable", async (req) => {
    office.configure({ enabled: true });
    office.install();
    audit(db, actor(req), "settings.update", { fields: ["office"], changes: { office: { from: false, to: true } } });
    return office.status();
  });
  app.post("/api/office/disable", async (req) => {
    office.configure({ enabled: false });
    await office.stop().catch(() => {});
    audit(db, actor(req), "settings.update", { fields: ["office"], changes: { office: { from: true, to: false } } });
    return office.status();
  });
  app.post("/api/office/uninstall", async (req) => {
    office.configure({ enabled: false });
    await office.uninstall();
    audit(db, actor(req), "settings.update", { fields: ["office"], changes: { office: { from: true, to: "uninstalled" } } });
    return office.status();
  });
  // The file itself. Only types the browser can't run as a page are served inline; text (HTML included) is
  // served as plain text and everything else as a download, all sandboxed, so a delivered file can never act
  // with the owner's session on this origin.
  app.get("/api/artifacts/:id/file", async (req, reply) => {
    const q = VersionQuery.parse(req.query);
    const a = artifactOr404(id(req));
    const v = artifacts.version(a.id, q.v);
    const file = artifacts.filePath(a.id, v.version);
    const size = fs.statSync(file).size;
    const inline = q.download === "1" ? null : inlineType(v);
    reply
      .header("Content-Type", inline ?? v.mime)
      .header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", v.filename))
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", q.v ? "private, max-age=31536000, immutable" : "private, no-cache")
      .header("Accept-Ranges", "bytes");
    // Chrome won't show a PDF in a sandboxed document; PDFs are checked by their bytes when stored.
    if (v.kind !== "pdf") reply.header("Content-Security-Policy", "sandbox");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
      return reply.send(fs.createReadStream(file, { start, end }));
    }
    return reply.header("Content-Length", size).send(fs.createReadStream(file));
  });
  app.patch("/api/artifacts/:id", async (req) => {
    const b = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body);
    const cur = artifactOr404(id(req));
    const a = artifacts.rename(cur.id, b.title);
    audit(db, actor(req), "artifact.rename", { id: a.id, title: a.title, changes: changesOf({ title: cur.title }, { title: a.title }, ["title"]) });
    return a;
  });
  // The owner edits a text artifact in place, or brings back an older version; either way a new version.
  app.post("/api/artifacts/:id/versions", { bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    const b = z
      .union([z.object({ content: z.string().max(MAX_ARTIFACT_TEXT), note: z.string().trim().max(300).optional() }), z.object({ restore: z.number().int().min(1) })])
      .parse(req.body);
    const cur = artifactOr404(id(req));
    const a =
      "restore" in b
        ? artifacts.restore(cur.id, b.restore)
        : artifacts.saveText({ agentId: cur.agent_id, runId: null, conversationId: null, artifactId: cur.id, content: b.content, note: b.note, author: "user" });
    audit(db, actor(req), "restore" in b ? "artifact.restore" : "artifact.edit", { id: a.id, version: a.version });
    return a;
  });
  app.delete("/api/artifacts/:id", async (req) => {
    const a = artifactOr404(id(req));
    artifacts.remove(a.id);
    audit(db, actor(req), "artifact.delete", { id: a.id, title: a.title });
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

  // ── desktops (instances) ─────────────────────────────────
  app.get("/api/desktops", async () => desktops.list());
  app.get("/api/desktops/capabilities", async () => hub.hostcaps.snapshot());
  app.post("/api/desktops/capabilities/refresh", async () => {
    await hub.hostcaps.refresh();
    return hub.hostcaps.snapshot();
  });
  app.post("/api/desktops", async (req) => {
    const b = z
      .object({ name: z.string().min(1).max(40), kind: DesktopKind.default("desktop"), options: DesktopOptions.optional(), agentIds: z.array(z.string()).max(50).optional() })
      .parse(req.body);
    const d = await desktops.create({ name: b.name, kind: b.kind, options: b.options });
    if (b.agentIds?.length) desktops.setAgents(d.id, b.agentIds);
    audit(db, actor(req), "desktop.create", { id: d.id, name: b.name, kind: d.kind });
    return d;
  });
  app.patch("/api/desktops/:id", async (req) => {
    const b = z
      .object({ name: z.string().min(1).max(40).optional(), options: DesktopOptions.optional(), agentIds: z.array(z.string()).max(50).optional(), confirmDataLoss: z.boolean().optional() })
      .parse(req.body);
    const snapshot = () => {
      const r = desktops.row(id(req));
      return { name: r.name, options: desktops.options(r), agentIds: desktops.agentIds(r.id) };
    };
    const before = snapshot();
    const out = await desktops.update(id(req), { name: b.name, options: b.options }, { confirmDataLoss: b.confirmDataLoss });
    if (b.agentIds) desktops.setAgents(id(req), b.agentIds);
    const after = snapshot();
    audit(db, actor(req), "desktop.update", { id: id(req), name: after.name, changes: changesOf(before, after, ["name", "options", "agentIds"]), ...out });
    return { ok: true, ...out };
  });
  app.delete("/api/desktops/:id", async (req) => {
    const name = desktops.row(id(req)).name;
    await desktops.remove(id(req));
    audit(db, actor(req), "desktop.delete", { id: id(req), name });
    return { ok: true };
  });
  app.post("/api/desktops/:id/start", async (req) => {
    await desktops.start(id(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/stop", async (req) => {
    if (desktops.lease(id(req)).holder !== "none") throw new HttpError(409, "实例正在使用中");
    await desktops.stop(id(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/pause", async (req) => {
    if (desktops.lease(id(req)).holder !== "none") throw new HttpError(409, "实例正在使用中");
    await desktops.pause(id(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/resume", async (req) => {
    await desktops.resume(id(req));
    return { ok: true };
  });
  app.post("/api/desktops/:id/restart", async (req) => {
    await desktops.restart(id(req));
    audit(db, actor(req), "desktop.restart", { id: id(req), name: desktops.row(id(req)).name });
    return { ok: true };
  });
  app.get("/api/desktops/:id/screenshot", async (req, reply) => {
    const w = Number((req.query as { width?: string }).width ?? 480);
    const img = await desktops.thumbnail(id(req), Math.min(Math.max(w, 160), 1280));
    if (!img) return reply.code(404).send({ error: "暂无画面" });
    reply.header("Content-Type", "image/jpeg").header("Cache-Control", "no-store");
    return reply.send(img);
  });
  /** Owner-only input outside VNC (Android navigation keys); needs the owner to hold the instance. */
  app.post("/api/desktops/:id/action", async (req) => {
    if (desktops.lease(id(req)).holder !== "human") throw new HttpError(409, "请先接管");
    const b = z.object({ type: z.enum(["key"]), keys: z.string().min(1).max(40) }).parse(req.body);
    await desktops.action(id(req), b);
    return { ok: true };
  });
  app.get("/api/desktops/:id/android/gsf-id", async (req) => ({ id: await desktops.androidGsfId(id(req)) }));
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
    if (desktops.lease(id(req)).holder !== "human") throw new HttpError(409, "请先接管");
    const b = z.object({ text: z.string().max(20000) }).parse(req.body);
    await desktops.clipboard(id(req), b.text);
    return { ok: true };
  });
  app.post("/api/desktops/:id/ticket", async (req) => {
    // Opening the viewer counts as use: thaw a paused instance so the screen is live.
    await desktops.wake(id(req));
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
  // Import memory exported from another assistant: preview first (writes nothing), then add what the user kept.
  app.post("/api/agents/:id/memory/import/preview", async (req) => {
    const b = z.object({ text: z.string().min(1).max(IMPORT_TEXT_MAX) }).parse(req.body);
    agents.get(id(req));
    return learning.previewImport(id(req), b.text);
  });
  app.post("/api/agents/:id/memory/import", async (req) => {
    const b = z
      .object({ items: z.array(z.object({ scope: z.enum(["agent", "user"]), text: z.string().min(1).max(400) })).min(1).max(200) })
      .parse(req.body);
    agents.get(id(req));
    const r = knowledge.importMemory(id(req), b.items, "用户");
    return { events: r.events, added: r.plan.filter((p) => p.status === "new").length, skipped: r.plan.filter((p) => p.status !== "new").length };
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

  // ── performance ──────────────────────────────────────────
  const PerfQuery = z.object({ range: z.enum(["1h", "24h"]).default("1h"), history: z.enum(["0", "1"]).default("1") });
  /** Containers folded into what the owner knows: each instance, each agent, and the hub's own services. */
  const perfGroups = (range: PerfRange | null): PerfGroup[] => {
    const all = hub.perf.containers(range);
    const SYSTEM: Record<string, string> = { hub: "Constella 服务", office: "在线 Office" };
    return [
      ...desktops.rows().map((d) => groupOf({ type: "instance", id: d.id, name: d.name, kind: d.kind }, all.filter((c) => c.desktopId === d.id))),
      ...agents.list().map((a) => groupOf({ type: "agent", id: a.id, name: a.name, emoji: a.emoji }, all.filter((c) => c.role === "agent" && c.agentId === a.id))),
      ...Object.entries(SYSTEM)
        .map(([role, name]) => groupOf({ type: "system", id: role, name }, all.filter((c) => c.role === role)))
        .filter((g) => g.containers.length),
    ];
  };
  app.get("/api/perf", async (req) => {
    const q = PerfQuery.parse(req.query);
    const range = q.range as PerfRange;
    const host = hub.perf.host(range);
    return { interval: PERF_INTERVAL_S, range, host: { ...host, history: q.history === "1" ? host.history : [] }, groups: perfGroups(q.history === "1" ? range : null) };
  });
  app.get("/api/desktops/:id/perf", async (req) => {
    const q = PerfQuery.parse(req.query);
    desktops.row(id(req));
    const g = perfGroups(q.range as PerfRange).find((x) => x.type === "instance" && x.id === id(req));
    return { interval: PERF_INTERVAL_S, range: q.range, cores: hub.perf.host("1h").info?.cores ?? null, group: g ?? null };
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
      .object({ range: z.enum(["today", "7d", "30d", "365d"]).default("today"), agent: z.string().optional(), model: z.string().optional(), provider: z.string().optional() })
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
    runTimeoutMinutes: minutes(RUN_TIMEOUTS).optional(),
    runWatchdogMinutes: minutes([0, 5, 10, 20, 30, 60]).optional(),
    approvalMode: z.enum(["ask", "smart", "auto"]).optional(),
    agentIdleMinutes: minutes([0, 10, 30, 60, 120, 360]).optional(),
    desktopIdleMinutes: minutes([0, 10, 30, 60, 120, 360]).optional(),
    desktopIdleAction: IdleAction.optional(),
    androidBackend: z.enum(["auto", "redroid", "emulator", "off"]).optional(),
    maxInstances: z.number().int().min(1).max(50).optional(),
    maxAndroidInstances: z.number().int().min(0).max(20).optional(),
    instanceApproval: z.object({ create: z.boolean(), update: z.boolean() }).partial().optional(),
    autoReflect: z.boolean().optional(),
    reflectMinToolCalls: z.number().int().min(1).max(50).optional(),
    notifyOn: z.object({ done: z.boolean(), failed: z.boolean(), approval: z.boolean(), stuck: z.boolean() }).partial().optional(),
    quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).partial().optional(),
    backupKeep: z.number().int().min(1).max(60).optional(),
    modelNameFormat: z.enum(["paren", "dash"]).optional(),
  });
  app.patch("/api/settings", async (req) => {
    const b = SettingsPatch.parse(req.body);
    const before = settings.view();
    checkModel(b.defaultModel);
    checkModel(b.reflectModel);
    const set = (key: string, v: unknown) => v !== undefined && kvSet(db, `settings.${key}`, String(v));
    for (const key of ["approvalMode", "autoResume", "browserHtml", "maxAutoResumes", "runTimeoutMinutes", "runWatchdogMinutes", "agentIdleMinutes", "desktopIdleMinutes", "desktopIdleAction", "androidBackend", "maxInstances", "maxAndroidInstances", "autoReflect", "reflectMinToolCalls", "backupKeep", "modelNameFormat"] as const)
      set(key, b[key]);
    if (b.defaultModel) kvSet(db, "settings.defaultModel", b.defaultModel);
    if (b.reflectModel) kvSet(db, "settings.reflectModel", b.reflectModel);
    if (b.defaultEffort !== undefined) kvSet(db, "settings.defaultEffort", b.defaultEffort ?? "");
    for (const [k, v] of Object.entries(b.notifyOn ?? {})) set(`notify.${k}`, v);
    for (const [k, v] of Object.entries(b.quietHours ?? {})) set(`quiet.${k}`, v);
    for (const [k, v] of Object.entries(b.instanceApproval ?? {})) set(`instanceApproval.${k}`, v);
    if (b.newapiAdminToken !== undefined) b.newapiAdminToken ? hub.secrets.set("settings", "newapiAdminToken", b.newapiAdminToken) : hub.secrets.delete("settings", "newapiAdminToken");
    if (b.newapiAdminUserId) kvSet(db, "settings.newapiAdminUserId", b.newapiAdminUserId);
    if (b.telegramBotToken !== undefined) b.telegramBotToken ? hub.secrets.set("settings", "telegramBotToken", b.telegramBotToken) : hub.secrets.delete("settings", "telegramBotToken");
    if (b.telegramChatId !== undefined) kvSet(db, "settings.telegramChatId", b.telegramChatId);
    const after = settings.view();
    // Secrets are never written to the log; only whether this save set a value or cleared it.
    const secrets = ["newapiAdminToken", "telegramBotToken"] as const;
    const changes: Record<string, unknown> = changesOf(before, after, Object.keys(b).filter((k) => !(secrets as readonly string[]).includes(k)));
    for (const k of secrets) if (b[k] !== undefined) changes[k] = { secret: true, to: !!b[k] };
    audit(db, actor(req), "settings.update", { fields: Object.keys(b), changes });
    return after;
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
  app.get("/api/audit/:id", async (req) => {
    const row = db.prepare("SELECT * FROM audit WHERE id = ?").get(Number(id(req))) as { action: string; detail: string | null } | undefined;
    if (!row) throw new HttpError(404, "记录不存在");
    return { ...row, refs: auditRefs(db, row) };
  });
  app.get("/api/audit", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(300), before: z.coerce.number().int().optional() }).parse(req.query);
    return q.before
      ? db.prepare("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?").all(q.before, q.limit)
      : db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(q.limit);
  });
}

/** How a version may be shown in the browser: its own type for media and PDFs, plain text for text, else not at all. */
function inlineType(v: ArtifactVersionRow): string | null {
  switch (v.kind) {
    case "image":
    case "pdf":
    case "audio":
    case "video":
      return v.mime;
    case "svg":
      return "image/svg+xml";
    case "file":
      return null;
    default:
      return "text/plain; charset=utf-8";
  }
}

/** Content-Disposition with an ASCII fallback and the real (possibly Chinese) name per RFC 6266. */
function contentDisposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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
