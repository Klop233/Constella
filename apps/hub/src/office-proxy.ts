import http from "node:http";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { config } from "./config.ts";
import type { Hub } from "./app.ts";
import { OFFICE_CONTAINER, OFFICE_PREFIX } from "./office.ts";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length", "cookie"]);

/**
 * Serves the Document Server on the hub's own origin under /office-ds/, so the editor works through every
 * entry point (Tailscale, tunnel, local) without exposing another port. Only signed-in sessions get through.
 */
export function registerOfficeProxy(hub: Hub): void {
  const { app, auth, office } = hub;
  app.register(async (scope: FastifyInstance) => {
    // Bodies are forwarded as they are.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 128 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const forwarded = (req: { headers: Record<string, any>; protocol: string }) => ({
      "x-forwarded-host": `${req.headers.host ?? ""}${OFFICE_PREFIX}`,
      "x-forwarded-proto": String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0]!.trim(),
    });
    const targetPath = (url: string) => url.slice(OFFICE_PREFIX.length) || "/";

    scope.addHook("onRequest", async (req, reply) => {
      if (!auth.check(req)) return reply.code(401).send({ error: "unauthorized" });
      const origin = req.headers.origin;
      if (origin && !config.origins.includes(origin) && !origin.endsWith(String(req.headers.host)) && !(await import("./trusted.ts")).isTrusted(req)) {
        return reply.code(403).send({ error: "origin not allowed" });
      }
    });

    scope.route({
      method: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
      url: `${OFFICE_PREFIX}/*`,
      handler: (req, reply) => {
        office.touch();
        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
        Object.assign(headers, forwarded(req), { host: OFFICE_CONTAINER });
        const body = req.body as Buffer | undefined;
        if (body?.length) headers["content-length"] = body.length;
        reply.hijack();
        const up = http.request({ host: OFFICE_CONTAINER, port: 80, method: req.method, path: targetPath(req.url), headers }, (res) => {
          reply.raw.writeHead(res.statusCode ?? 502, res.headers);
          res.pipe(reply.raw);
        });
        up.on("error", () => {
          if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
          reply.raw.end(JSON.stringify({ error: "在线编辑器没有响应，可能还在启动" }));
        });
        up.end(body?.length ? body : undefined);
      },
      wsHandler: (socket, req) => {
        office.touch();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("sec-websocket") && typeof v === "string") headers[k] = v;
        Object.assign(headers, forwarded(req));
        const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const up = new WebSocket(`ws://${OFFICE_CONTAINER}${targetPath(req.url)}`, protocols, { headers });
        const queue: { data: WebSocket.RawData; binary: boolean }[] = [];
        socket.on("message", (data, binary) => (up.readyState === WebSocket.OPEN ? up.send(data, { binary }) : queue.push({ data, binary })));
        up.on("open", () => {
          for (const m of queue.splice(0)) up.send(m.data, { binary: m.binary });
        });
        up.on("message", (data, binary) => socket.send(data, { binary }));
        up.on("close", () => socket.close());
        up.on("error", () => socket.close());
        socket.on("close", () => up.close());
        socket.on("error", () => up.close());
      },
    });
  });
}
