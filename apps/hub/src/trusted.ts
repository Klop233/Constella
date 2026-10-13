import http from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Optional trusted entry for development: a second port whose connections are treated as the
 * owner without logging in. Bind it only to private interfaces (loopback / tailnet) in compose.
 */
const trustedSockets = new WeakSet<Socket>();

export function isTrusted(req: FastifyRequest): boolean {
  return trustedSockets.has(req.raw.socket);
}

/** Accepts connections on `port` and hands them to the app's own server, marking the socket trusted. */
export function listenTrusted(app: FastifyInstance, host: string, port: number): Promise<void> {
  const server = http.createServer((req, res) => app.server.emit("request", req, res));
  server.on("connection", (s) => trustedSockets.add(s));
  server.on("upgrade", (req, socket, head) => app.server.emit("upgrade", req, socket, head));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
