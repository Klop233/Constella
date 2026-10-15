import { STATUS_TEXT } from "../lib/format";
import type { Agent, RunStatus as RunStatusValue } from "../lib/types";
import { cx, StatusDot, StatusText } from "./ui";

export function AgentAvatar({ emoji, size = "md" }: { emoji: string; size?: "sm" | "md" | "lg" }) {
  const s = { sm: "size-7 text-base rounded-md", md: "size-9 text-xl rounded-lg", lg: "size-11 text-2xl rounded-xl" }[size];
  return <div className={cx("grid place-items-center bg-surface-2 border border-line shrink-0", s)}>{emoji}</div>;
}

function statusOf(agent: Agent): { text: string; tone: "ok" | "busy" | "warn" | "danger" | "off" } {
  const active = agent.activeRuns[0];
  if (active) return { text: STATUS_TEXT[active.status], tone: active.status === "waiting_approval" || active.status === "paused_by_user" ? "warn" : "busy" };
  if (agent.container === "running" && agent.connected) return { text: "在线", tone: "ok" };
  if (agent.container === "error") return { text: "异常", tone: "danger" };
  return { text: "休眠", tone: "off" };
}

export function AgentStatus({ agent }: { agent: Agent }) {
  const { text, tone } = statusOf(agent);
  return (
    <StatusDot tone={tone} className="text-xs mt-0.5 max-w-full">
      {text}
    </StatusDot>
  );
}

/** How a conversation's last run stands, at the end of its row; nothing once it is done. */
export function RunStatus({ status }: { status: RunStatusValue | null | undefined }) {
  if (!status || status === "done") return null;
  const tone = status === "running" || status === "queued" ? "busy" : status === "waiting_approval" || status === "paused_by_user" ? "warn" : status === "failed" ? "danger" : "muted";
  return <StatusText tone={tone}>{STATUS_TEXT[status]}</StatusText>;
}
