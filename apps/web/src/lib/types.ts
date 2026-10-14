import type { AgentEvent, DesktopLease, DesktopPolicy, RunStatus } from "@constella/protocol";

export type { AgentEvent, DesktopLease, DesktopPolicy, RunStatus };

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

/** What an entry's ids point at today; a missing key means the object no longer exists. */
export interface AuditRefs {
  agent?: { id: string; name: string; emoji: string; archived: boolean };
  approval?: { id: string; kind: string; summary: string; detail: string | null; status: string; source: string; created_at: string; resolved_at: string | null; answer: string | null };
  run?: { id: string; status: RunStatus; model: string; prompt: string; error: string | null; created_at: string; finished_at: string | null };
  conversation?: { id: string; title: string };
  desktop?: { id: string; name: string };
  schedule?: { id: string; name: string; cron: string; enabled: boolean };
  incident?: { id: string; title: string; kind: string; status: string };
}

export interface AuditEntryDetail extends AuditEntry {
  refs: AuditRefs;
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
