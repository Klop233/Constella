import type { AgentEvent } from "@constella/protocol";

/** Contract every engine adapter (Codex app-server first) implements; see docs/decisions/0001-engine-codex.md. */
export interface EngineAdapter {
  readonly name: string;
  startRun(input: { runId: string; prompt: string; model: string }): AsyncIterable<AgentEvent>;
  steer(runId: string, text: string): Promise<void>;
  resolveApproval(runId: string, approvalId: string, decision: "approve" | "deny"): Promise<void>;
  stop(runId: string): Promise<void>;
}
