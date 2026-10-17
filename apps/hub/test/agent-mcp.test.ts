import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-agent-mcp-"));
process.env.CONSTELLA_DATA_DIR = tmp;

const { openDb } = await import("../src/db.ts");
const { registerMcp } = await import("../src/mcp.ts");

type Db = ReturnType<typeof openDb>;

function row(id: string, manageConstella: boolean, archived = false): any {
  return {
    id,
    name: id === "manager" ? "平台管家" : id,
    emoji: "✨",
    template: "assistant",
    persona: "p",
    model: "m",
    effort: null,
    approval_policy: "auto",
    desktop_policy: '{"desktopIds":[]}',
    host_access: 0,
    manage_constella: manageConstella ? 1 : 0,
    token_hash: `hash-${id}`,
    created_at: "now",
    updated_at: "now",
    archived: archived ? 1 : 0,
  };
}

async function withMcp(manageConstella: boolean, fn: (client: Client, seen: { approvals: unknown[]; events: unknown[]; removed: string[] }) => Promise<void>): Promise<void> {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO runs (id, conversation_id, agent_id, prompt, status, model, created_at, last_event_at) VALUES ('r1', 'c1', 'manager', 'p', 'running', 'm', 'now', 'now')",
  ).run();
  const manager = row("manager", manageConstella);
  const target = row("worker", false);
  const created = row("created", false);
  const all = [manager, target, created];
  const seen = { approvals: [] as unknown[], events: [] as unknown[], removed: [] as string[] };
  const agents = {
    byToken: (token: string) => (token === "tok" ? manager : undefined),
    list: (includeArchived = false) => all.filter((a) => includeArchived || !a.archived),
    get: (id: string) => {
      const a = all.find((x) => x.id === id);
      if (!a) throw new Error("agent not found");
      return a;
    },
    create: (input: any) => {
      Object.assign(created, { name: input.name, model: input.model ?? "m", manage_constella: input.manageConstella ? 1 : 0 });
      return created;
    },
    update: (id: string, patch: any) => {
      const a = all.find((x) => x.id === id)!;
      if (patch.name !== undefined) a.name = patch.name;
      if (patch.manageConstella !== undefined) a.manage_constella = patch.manageConstella ? 1 : 0;
      return a;
    },
    archive: (id: string) => {
      all.find((x) => x.id === id)!.archived = 1;
    },
  };
  const app = Fastify();
  registerMcp(app, {
    db,
    agents,
    runs: {
      requestHubApproval: async (...args: unknown[]) => (seen.approvals.push(args), true),
      send: async () => ({ runId: "run-worker", conversationId: "conv-worker", steered: false }),
      appendFor: () => {},
    },
    knowledge: {},
    desktops: {},
    notifier: {},
    scheduler: {},
    containers: {
      agentName: (id: string) => `container-${id}`,
      state: async () => "running",
      remove: async (name: string) => void seen.removed.push(name),
    },
    hostcaps: {},
    artifacts: {},
    credentials: {},
    recovery: {},
    browserHtml: () => false,
    instanceApproval: () => ({ create: false, update: false }),
    events: { publish: (_type: string, data: unknown) => void seen.events.push(data) },
  } as any);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "test", version: "0" });
  const url = new URL(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer tok" } } }));
  try {
    await fn(client, seen);
  } finally {
    await client.close();
    await app.close();
  }
}

describe("Constella agent management tools", () => {
  it("are hidden unless the agent has the explicit management capability", async () => {
    await withMcp(false, async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("agent_create");
      expect(names).not.toContain("agent_list");
    });
  });

  it("lists, creates, updates, restarts, archives and messages another agent", async () => {
    await withMcp(true, async (client, seen) => {
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["agent_list", "agent_get", "agent_create", "agent_update", "agent_delete", "agent_restart", "agent_message"])
        expect(names).toContain(name);

      const list = await call("agent_list", {});
      expect(JSON.parse(list.content[0].text).map((a: any) => a.id)).toContain("worker");

      const made = await call("agent_create", { name: "新 agent", reason: "拆分一个长期任务" });
      expect(made.content[0].text).toContain("id created");
      expect(seen.approvals).toHaveLength(1);
      expect(seen.events).toContainEqual({ id: "created" });

      await call("agent_update", { id: "worker", name: "执行员", reason: "明确职责" });
      expect(seen.approvals).toHaveLength(2);

      const sent = await call("agent_message", { id: "worker", text: "请整理现有资料" });
      expect(sent.content[0].text).toContain("run-worker");
      expect(seen.approvals).toHaveLength(2);

      await call("agent_restart", { id: "worker", reason: "重新加载环境" });
      expect(seen.approvals).toHaveLength(3);
      expect(seen.removed).toContain("container-worker");

      await call("agent_delete", { id: "worker", reason: "任务已结束" });
      expect(seen.approvals).toHaveLength(4);
      expect(seen.removed).toContain("container-worker");
    });
  });
});
