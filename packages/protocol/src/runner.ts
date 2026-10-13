import { z } from "zod";
import type { AgentEvent } from "./index.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as the runner reports it; the hub adds id, seq, ts and agentId. */
export type RunnerEvent = DistributiveOmit<AgentEvent, "id" | "seq" | "ts" | "agentId">;

export const ApprovalPolicy = z.enum(["auto", "ask"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export type HubToRunner =
  | {
      t: "start";
      runId: string;
      conversationId: string;
      /** Codex thread to resume; null starts a new thread. */
      threadId: string | null;
      text: string;
      images?: string[];
      model: string;
      /** Codex reasoning level ("low", "medium", "high", "xhigh", "max", …), one the model supports. */
      effort?: string;
      instructions: string;
      approvalPolicy: ApprovalPolicy;
      skillRoots: string[];
    }
  | { t: "steer"; runId: string; text: string }
  | { t: "interrupt"; runId: string }
  | { t: "approval_decision"; runId: string; approvalId: string; decision: "approve" | "deny" }
  | { t: "ping" };

export type RunnerToHub =
  | { t: "hello"; agentId: string; version: string; activeRuns: string[] }
  | { t: "event"; event: RunnerEvent }
  | { t: "thread"; runId: string; threadId: string }
  | { t: "turn_done"; runId: string; status: "done" | "failed" | "cancelled"; error?: string }
  /** Codex's model catalog: the reasoning levels each model supports, weakest first. */
  | { t: "models"; models: { id: string; efforts: string[]; defaultEffort: string | null }[] }
  | { t: "pong" };

export const RunnerToHubSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), agentId: z.string(), version: z.string(), activeRuns: z.array(z.string()) }),
  z.object({ t: z.literal("event"), event: z.object({ type: z.string(), runId: z.string() }).loose() }),
  z.object({ t: z.literal("thread"), runId: z.string(), threadId: z.string() }),
  z.object({
    t: z.literal("turn_done"),
    runId: z.string(),
    status: z.enum(["done", "failed", "cancelled"]),
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal("models"),
    models: z.array(z.object({ id: z.string(), efforts: z.array(z.string()), defaultEffort: z.string().nullable() })).max(500),
  }),
  z.object({ t: z.literal("pong") }),
]);
