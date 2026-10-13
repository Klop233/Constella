import { STATUS_TEXT } from "../lib/format";
import type { Agent } from "../lib/types";
import { cx } from "./ui";

export function AgentAvatar({ emoji, size = "md" }: { emoji: string; size?: "sm" | "md" | "lg" }) {
  const s = { sm: "size-7 text-base rounded-md", md: "size-9 text-xl rounded-lg", lg: "size-11 text-2xl rounded-xl" }[size];
  return <div className={cx("grid place-items-center bg-surface-2 border border-line shrink-0", s)}>{emoji}</div>;
}

function statusOf(agent: Agent): { text: string; dot: string } {
  const active = agent.activeRuns[0];
  let text = "空闲";
  let dot = "bg-[var(--muted)]";
  if (active) {
    text = STATUS_TEXT[active.status];
    dot = active.status === "waiting_approval" || active.status === "paused_by_user" ? "bg-[var(--warn)]" : "bg-accent pulse-dot";
  } else if (agent.container === "running" && agent.connected) {
    text = "在线";
    dot = "bg-[var(--ok)]";
  } else if (agent.container === "error") {
    text = "异常";
    dot = "bg-[var(--danger)]";
  } else {
    text = "休眠";
  }
  return { text, dot };
}

/** Just the status dot, with the status as its tooltip. */
export function AgentDot({ agent }: { agent: Agent }) {
  const { text, dot } = statusOf(agent);
  return <span title={text} aria-label={text} className={cx("size-1.5 rounded-full", dot)} />;
}

export function AgentStatus({ agent }: { agent: Agent }) {
  const { text, dot } = statusOf(agent);
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted mt-0.5">
      <span className={cx("size-1.5 rounded-full", dot)} />
      {text}
    </div>
  );
}
