import { bootHub, createHub } from "./app.ts";
import { config } from "./config.ts";
import { listenTrusted } from "./trusted.ts";

const hub = await createHub({ logger: process.env.CONSTELLA_LOG === "debug" });
await bootHub(hub);
await hub.app.listen({ host: config.listenHost, port: config.listenPort });
console.log(`constella-hub listening on ${config.listenHost}:${config.listenPort}`);
let trustedServer: import("node:http").Server | undefined;
if (config.trustedPort) {
  trustedServer = await listenTrusted(hub.app, config.listenHost, config.trustedPort);
  console.log(`constella-hub trusted (no-login) entry on ${config.listenHost}:${config.trustedPort}`);
}

const shutdown = async () => {
  await new Promise<void>((resolve) => trustedServer?.close(() => resolve()) ?? resolve());
  await hub.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
