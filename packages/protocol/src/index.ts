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

/**
 * What a "secret" approval asks the owner to type: one input per field. The values never appear in events,
 * the database or the model's context; they go from the owner's browser to the hub's memory to the page.
 */
export const SecretSpec = z.object({
  fields: z.array(z.object({ name: z.string(), label: z.string(), secret: z.boolean() })).min(1).max(3),
  /** Where it will be used (a site or app), shown on the card. */
  target: z.string().optional(),
  /** A matching vault item the owner can allow instead of typing anything. */
  vault: z.object({ name: z.string(), username: z.string().optional() }).optional(),
  /** Why the vault wasn't used (declined, slow reviewer), shown above the inputs. */
  note: z.string().optional(),
});
export type SecretSpec = z.infer<typeof SecretSpec>;

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
    kind: z.enum(["command", "file_change", "host_access", "desktop", "decision", "secret", "other"]),
    summary: z.string(),
    detail: z.string().optional(),
    /** kind=secret: the inputs the owner is asked to fill (agent needs a login or password). */
    secret: SecretSpec.optional(),
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

/** What an instance runs: a bare browser, a Linux (Xfce) desktop, or an Android device. */
export const DesktopKind = z.enum(["browser", "desktop", "android"]);
export type DesktopKind = z.infer<typeof DesktopKind>;

/** How an Android instance runs: Redroid (container, needs binder) or the SDK emulator (needs KVM). */
export const AndroidBackend = z.enum(["redroid", "emulator"]);
export type AndroidBackend = z.infer<typeof AndroidBackend>;

/** What happens to an instance nobody has used for a while: freeze it (keeps memory), stop it, or leave it running. */
export const IdleAction = z.enum(["pause", "stop", "none"]);
export type IdleAction = z.infer<typeof IdleAction>;

/** Per-instance settings; missing fields fall back to the kind's defaults and the global idle settings. */
export const DesktopOptions = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(320).max(3840).optional(),
  /** Android only. */
  dpi: z.number().int().min(120).max(640).optional(),
  /** Android only; fixed when the instance is created (the backends' data isn't interchangeable). */
  backend: AndroidBackend.optional(),
  /** Android only: run ARM-only apps through native-bridge translation. */
  armTranslation: z.boolean().optional(),
  /** Android only: Google Play services and store. */
  googlePlay: z.boolean().optional(),
  idleAction: IdleAction.optional(),
  idleMinutes: z.number().int().min(0).max(1440).optional(),
});
export type DesktopOptions = z.infer<typeof DesktopOptions>;

/** The instances an agent may use, in order of preference (any kinds). */
export const DesktopPolicy = z.object({ desktopIds: z.array(z.string()).max(32) });
export type DesktopPolicy = z.infer<typeof DesktopPolicy>;

/** Policy shapes from before instance kinds; still found in old databases and agent exports. */
export const LegacyDesktopPolicy = z.union([
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("fixed"), desktopId: z.string() }),
  z.object({ mode: z.literal("on_demand") }),
]);
export type LegacyDesktopPolicy = z.infer<typeof LegacyDesktopPolicy>;

export * from "./attachments.ts";
export * from "./runner.ts";
export * from "./widgets.ts";
export * from "./genui.ts";
