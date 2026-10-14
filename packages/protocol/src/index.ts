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
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "paused_by_user", "done", "failed", "cancelled"],
  waiting_approval: ["running", "paused_by_user", "done", "failed", "cancelled"],
  paused_by_user: ["running", "waiting_approval", "done", "failed", "cancelled"],
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

/**
 * What an artifact (a file or document the agent delivered) holds, which decides how it is previewed.
 * The first six are text: previewable as source, editable in place, readable back by the agent.
 */
export const TextArtifactKind = z.enum(["markdown", "html", "svg", "csv", "code", "text"]);
export const ArtifactKind = z.enum([...TextArtifactKind.options, "image", "pdf", "audio", "video", "file"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;
export const TEXT_ARTIFACT_KINDS: readonly ArtifactKind[] = TextArtifactKind.options;

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
    kind: z.enum(["command", "file_change", "host_access", "desktop", "decision", "other"]),
    summary: z.string(),
    detail: z.string().optional(),
    /** kind=decision: the choices the agent offers the owner, and which one it recommends. */
    options: z.array(z.object({ label: z.string(), detail: z.string().optional() })).optional(),
    recommended: z.number().int().nonnegative().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("approval.resolved"),
    approvalId: z.string(),
    decision: z.enum(["approve", "deny"]),
    by: z.enum(["user", "policy"]),
    /** kind=decision: what the owner chose (an option's label or their own words). */
    answer: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("desktop.action"),
    desktopId: z.string(),
    action: z.string(),
    thumbnail: z.string().optional(),
  }),
  /**
   * The agent asked the owner to take over a desktop (login, captcha, payment). Later events with the same
   * helpId move it along: the owner took over, handed it back (with an optional note), or nobody came in time.
   */
  z.object({
    ...envelope,
    type: z.literal("desktop.help"),
    helpId: z.string(),
    desktopId: z.string(),
    state: z.enum(["requested", "taken", "returned", "expired"]),
    reason: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("usage"),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    /** Of inputTokens, how many were served from the prompt cache. */
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    /** Tokens occupying the context window after this model request, and the window size. */
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().optional(),
    /** Wall time of this model request (from the previous boundary to its usage report), for tokens/s. */
    durationMs: z.number().int().nonnegative().optional(),
  }),
  /** The agent delivered a file or document into the chat (a new artifact, or a new version of one). */
  z.object({
    ...envelope,
    type: z.literal("artifact"),
    artifactId: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    kind: ArtifactKind,
    filename: z.string(),
    size: z.number().int().nonnegative(),
    note: z.string().optional(),
  }),
  /** Something the hub did on its own for this run: repaired a runner, a supervisor stepped in, filed an incident. */
  z.object({
    ...envelope,
    type: z.literal("system.notice"),
    kind: z.enum(["recovery", "supervisor", "incident"]),
    text: z.string(),
    incidentId: z.string().optional(),
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

export * from "./runner.ts";
