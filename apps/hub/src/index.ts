import { bootHub, createHub } from "./app.ts";
import { config } from "./config.ts";

const hub = await createHub({ logger: process.env.CONSTELLA_LOG === "debug" });
await bootHub(hub);
await hub.app.listen({ host: config.listenHost, port: config.listenPort });
console.log(`constella-hub listening on ${config.listenHost}:${config.listenPort}`);

const shutdown = async () => {
  await hub.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
