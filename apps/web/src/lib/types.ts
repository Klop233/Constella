import type { AgentEvent, ArtifactKind, DesktopLease, DesktopPolicy, RunStatus } from "@constella/protocol";

export type { AgentEvent, ArtifactKind, DesktopLease, DesktopPolicy, RunStatus };

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
  /** "decision" is a multiple-choice question from the agent (ask_user); the rest are approvals. */
  kind: string;
  summary: string;
  detail: string | null;
  status: string;
  created_at: string;
  options?: DecisionOption[] | null;
  recommended?: number | null;
  conversation_id?: string;
  agent_name?: string;
  agent_emoji?: string;
}

export interface DecisionOption {
  label: string;
  detail?: string;
}

export type IncidentAction = "continue" | "switch_model" | "restart_agent" | "new_thread" | "wait" | "restart" | "stop";

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
  kind: "start_failure" | "engine_error" | "stalled" | "stuck";
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
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

export interface Desktop {
  id: string;
  name: string;
  pinned_agent_id: string | null;
  state: string;
  leaseInfo: DesktopLease;
  last_used_at: string;
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
