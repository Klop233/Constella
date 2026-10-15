import type { AgentEvent, AndroidBackend, ArtifactKind, DesktopKind, DesktopLease, DesktopOptions, DesktopPolicy, IdleAction, RunStatus, SecretSpec } from "@constella/protocol";

export type { AgentEvent, AndroidBackend, ArtifactKind, DesktopKind, DesktopLease, DesktopOptions, DesktopPolicy, IdleAction, RunStatus, SecretSpec };

/** Codex reasoning level ("low", "medium", "high", "xhigh", "max", …); which ones apply depends on the model. */
export type Effort = string;


export interface Agent {
  id: string;
  name: string;
  emoji: string;
  template: string;
  persona: string;
  model: string;
  effort: string | null;
  approval_policy: "auto" | "ask";
  desktop_policy: DesktopPolicy;
  host_access: boolean;
  newapi_token_id: number | null;
  budget_daily_usd: number | null;
  container: "running" | "stopped" | "missing" | "starting" | "error";
  connected: boolean;
  activeRuns: { id: string; status: RunStatus; conversation_id: string }[];
  secrets: string[];
  created_at: string;
}

export interface Template {
  id: string;
  name: string;
  emoji: string;
  description: string;
  persona: string;
  desktopPolicy: DesktopPolicy;
  approvalPolicy: "auto" | "ask";
  hostAccess: boolean;
}

export interface Conversation {
  id: string;
  agent_id: string;
  title: string;
  source: string;
  model?: string | null;
  effort?: Effort | null;
  /** This conversation's single-turn time limit (0 = none); null follows the setting. */
  run_timeout_minutes?: number | null;
  archived_at?: string | null;
  updated_at: string;
  created_at: string;
  last_status?: RunStatus | null;
  agent_name?: string;
  agent_emoji?: string;
}

export interface Run {
  id: string;
  conversation_id: string;
  agent_id: string;
  prompt: string;
  status: RunStatus;
  error: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  feedback: number | null;
  created_at: string;
  finished_at: string | null;
  events: AgentEvent[];
}

export interface Approval {
  id: string;
  run_id: string;
  agent_id: string;
  /** "decision" is a multiple-choice question from the agent (ask_user), "secret" a request for a login; the rest are approvals. */
  kind: string;
  summary: string;
  detail: string | null;
  status: string;
  created_at: string;
  options?: DecisionOption[] | null;
  /** kind=secret: the inputs the owner is asked to fill. */
  secret?: SecretSpec | null;
  recommended?: number | null;
  conversation_id?: string;
  agent_name?: string;
  agent_emoji?: string;
}

export interface DecisionOption {
  label: string;
  detail?: string;
}

export type IncidentAction = "continue" | "switch_model" | "restart_agent" | "new_thread" | "wait" | "restart" | "stop" | "repair_instance" | "reset_instance" | "stop_instance";

export interface IncidentOption {
  title: string;
  detail: string;
  action: IncidentAction;
  model?: string;
  text: string;
}

/** Something that went wrong with a run: auto-handled (kept for the audit trail) or waiting for the owner to pick an option. */
export interface Incident {
  id: string;
  kind: "start_failure" | "engine_error" | "stalled" | "stuck" | "panic" | "instance" | "help";
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  /** The instance it is about (instance faults). */
  desktop_id: string | null;
  desktop_name?: string | null;
  title: string;
  summary: string;
  error: string | null;
  actions: string[];
  options: IncidentOption[];
  recommended: number | null;
  status: "analyzing" | "open" | "auto" | "adopted" | "dismissed";
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
  agent_name?: string | null;
  agent_emoji?: string | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  detail: string | null;
}

/** What an entry's ids point at today; a missing key means the object no longer exists. */
export interface AuditRefs {
  agent?: { id: string; name: string; emoji: string; archived: boolean };
  approval?: { id: string; kind: string; summary: string; detail: string | null; status: string; source: string; created_at: string; resolved_at: string | null; answer: string | null };
  run?: { id: string; status: RunStatus; model: string; prompt: string; error: string | null; created_at: string; finished_at: string | null };
  conversation?: { id: string; title: string };
  desktop?: { id: string; name: string };
  schedule?: { id: string; name: string; cron: string; enabled: boolean };
  incident?: { id: string; title: string; kind: string; status: string };
  artifact?: { id: string; title: string; filename: string; version: number };
  credentialRequest?: { id: string; item: string; fields: string[]; status: string; agentId: string; createdAt: string };
}

export interface AuditEntryDetail extends AuditEntry {
  refs: AuditRefs;
}

/** An instance: bare browser, Linux desktop or Android. */
export interface Desktop {
  id: string;
  name: string;
  kind: DesktopKind;
  options: DesktopOptions;
  /** running | paused | stopped | missing | starting | error */
  state: string;
  leaseInfo: DesktopLease;
  /** Agents bound to it. */
  agentIds: string[];
  viewers: number;
  last_used_at: string;
  /** What is being done to it right now (an operation, a start or a repair), if anything. */
  op: InstanceOp | null;
  /** Why the last operation failed, while it isn't running. */
  error: { op: InstanceOp; message: string; at: string } | null;
}

export type InstanceOp = "starting" | "stopping" | "restarting" | "pausing" | "repairing" | "resetting";

/** What the hub found out about an instance (`GET /api/desktops/:id/health`). */
export interface InstanceHealth {
  ok: boolean;
  state: "running" | "paused" | "stopped" | "missing" | "starting" | "broken";
  problem?: string;
  crashLoop: boolean;
  detail: string;
  op: InstanceOp | null;
}

export interface Availability {
  ok: boolean;
  reason?: string;
  warnings?: string[];
}

export interface BackendCaps extends Availability {
  arm: boolean;
  googlePlay: boolean;
}

/** What the host can run, from the hub's probes. */
export interface HostCaps {
  checkedAt: string | null;
  checking: boolean;
  kinds: Record<DesktopKind, Availability>;
  android: { setting: "auto" | AndroidBackend | "off"; backend: AndroidBackend | null; redroid: BackendCaps; emulator: BackendCaps };
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  tz: string;
  kind: "notify" | "agent_prompt" | "system";
  agent_id: string | null;
  payload: { title?: string; body?: string; text?: string };
  enabled: number;
  next_run: string | null;
  last: { fired_at: string; ok: number; detail: string | null } | null;
}

export interface LearningEvent {
  id: string;
  agent_id: string | null;
  scope: "agent" | "shared";
  kind: "memory" | "skill";
  op: string;
  target: string;
  summary: string;
  run_id: string | null;
  reverted: number;
  created_at: string;
  agent?: { name: string; emoji: string } | null;
}

export interface Skill {
  name: string;
  description: string;
  scope: "agent" | "shared";
  uses: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface Overview {
  agents: Agent[];
  approvals: Approval[];
  conversations: Conversation[];
  desktops: Desktop[];
  unread: number;
  /** Incidents waiting for the owner (open or being diagnosed). */
  incidents: Incident[];
}

/** A file or document an agent delivered; the fields describe its latest version. */
export interface Artifact {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  run_id: string | null;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  filename: string;
  mime: string;
  size: number;
  version: number;
  created_at: string;
  updated_at: string;
  agent_name?: string | null;
  agent_emoji?: string | null;
  /** Null when the conversation it came from was deleted. */
  conversation_title?: string | null;
}

export interface ArtifactVersion {
  version: number;
  run_id: string | null;
  kind: ArtifactKind;
  language: string | null;
  filename: string;
  mime: string;
  size: number;
  note: string | null;
  author: "agent" | "user";
  created_at: string;
}

export type ArtifactDetail = Artifact & { versions: ArtifactVersion[] };
