import { z } from "zod";

/** Lifecycle of a run; persisted so the hub can resume after a restart. */
export const RunStatus = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "paused_by_user",
  "done",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

const TERMINAL: readonly RunStatus[] = ["done", "failed", "cancelled"];

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "paused_by_user", "done", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  paused_by_user: ["running", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Fields shared by every event; `seq` is per-run and drives SSE resume (Last-Event-ID). */
const envelope = {
  id: z.string(),
  runId: z.string(),
  agentId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
};

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("run.status"), status: RunStatus, error: z.string().optional() }),
  z.object({ ...envelope, type: z.literal("message.delta"), messageId: z.string(), text: z.string() }),
  z.object({ ...envelope, type: z.literal("message.completed"), messageId: z.string(), text: z.string() }),
  z.object({ ...envelope, type: z.literal("reasoning.summary"), text: z.string() }),
  z.object({ ...envelope, type: z.literal("tool.started"), callId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ ...envelope, type: z.literal("tool.output"), callId: z.string(), chunk: z.string() }),
  z.object({
    ...envelope,
    type: z.literal("tool.completed"),
    callId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("approval.requested"),
    approvalId: z.string(),
    kind: z.enum(["command", "file_change", "host_access", "desktop", "other"]),
    summary: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("approval.resolved"),
    approvalId: z.string(),
    decision: z.enum(["approve", "deny"]),
    by: z.enum(["user", "policy"]),
  }),
  z.object({
    ...envelope,
    type: z.literal("desktop.action"),
    desktopId: z.string(),
    action: z.string(),
    thumbnail: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("usage"),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("learning.event"),
    kind: z.enum(["memory", "skill"]),
    op: z.enum(["add", "update", "delete", "create", "patch"]),
    target: z.string(),
    commit: z.string(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];

/** Who may drive a desktop right now; only one holder at a time. */
export const DesktopLease = z.union([
  z.object({ holder: z.literal("none") }),
  z.object({ holder: z.literal("human"), since: z.iso.datetime() }),
  z.object({ holder: z.literal("agent"), agentId: z.string(), runId: z.string(), since: z.iso.datetime() }),
]);
export type DesktopLease = z.infer<typeof DesktopLease>;

export const DesktopPolicy = z.union([
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("fixed"), desktopId: z.string() }),
  z.object({ mode: z.literal("on_demand") }),
]);
export type DesktopPolicy = z.infer<typeof DesktopPolicy>;
