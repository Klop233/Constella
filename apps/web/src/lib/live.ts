import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AgentEvent } from "./types";

type AgentListener = (conversationId: string, event: AgentEvent) => void;
type HubListener = (type: string, data: unknown) => void;

const agentListeners = new Set<AgentListener>();
const hubListeners = new Set<HubListener>();
let status: "connecting" | "open" | "closed" = "connecting";
const statusListeners = new Set<(s: typeof status) => void>();

function setStatus(s: typeof status) {
  status = s;
  for (const l of statusListeners) l(s);
}

/**
 * One EventSource for the whole app. The browser resends Last-Event-ID on reconnect, so the
 * hub replays anything missed while the phone was offline. Hub notifications invalidate queries.
 */
export function startLive(qc: QueryClient): () => void {
  let es: EventSource | null = null;
  let retry: number | undefined;
  let stopped = false;

  const connect = () => {
    if (stopped || es) return;
    setStatus("connecting");
    const current = new EventSource("/api/stream");
    es = current;
    current.addEventListener("open", () => {
      if (!stopped && es === current) setStatus("open");
    });
    current.addEventListener("error", () => {
      if (stopped || es !== current) return;
      setStatus("closed");
      if (current.readyState === EventSource.CLOSED) {
        es = null;
        retry = window.setTimeout(connect, 3000);
      }
    });
    current.addEventListener("agent", (e) => {
      if (stopped || es !== current) return;
      const { conversationId, event } = JSON.parse((e as MessageEvent).data) as { conversationId: string; event: AgentEvent };
      for (const l of agentListeners) l(conversationId, event);
      if (event.type === "run.status" || event.type === "approval.requested" || event.type === "approval.resolved") {
        void qc.invalidateQueries({ queryKey: ["overview"] });
        void qc.invalidateQueries({ queryKey: ["agents"] });
        void qc.invalidateQueries({ queryKey: ["conversations"] });
        void qc.invalidateQueries({ queryKey: ["approvals"] });
      }
    });
    current.addEventListener("hub", (e) => {
      if (stopped || es !== current) return;
      const { type, data } = JSON.parse((e as MessageEvent).data) as { type: string; data: unknown };
      for (const l of hubListeners) l(type, data);
      const keys: Record<string, string[][]> = {
        agent: [["overview"], ["agents"], ["agent"]],
        desktop: [["overview"], ["desktops"]],
        "desktop.help": [["overview"], ["desktops"]],
        learning: [["learning"], ["knowledge"]],
        "learning.reverted": [["learning"], ["knowledge"]],
        schedule: [["schedules"]],
        "schedule.fired": [["schedules"]],
        notification: [["overview"], ["notifications"]],
        incident: [["overview"], ["incidents"], ["audit"]],
        artifact: [["artifacts"], ["artifact"]],
      };
      for (const k of keys[type] ?? []) void qc.invalidateQueries({ queryKey: k });
    });
  };
  connect();
  const onVisible = () => {
    if (!stopped && document.visibilityState === "visible" && !es) {
      window.clearTimeout(retry);
      connect();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    window.clearTimeout(retry);
    es?.close();
    es = null;
  };
}

export function useAgentEvents(listener: AgentListener): void {
  useEffect(() => {
    agentListeners.add(listener);
    return () => {
      agentListeners.delete(listener);
    };
  }, [listener]);
}

/** Hub notifications (incident, agent, schedule, …) as they arrive. */
export function useHubEvents(listener: HubListener): void {
  useEffect(() => {
    hubListeners.add(listener);
    return () => {
      hubListeners.delete(listener);
    };
  }, [listener]);
}

export function useLiveStatus(): typeof status {
  const [s, set] = useState(status);
  useEffect(() => {
    statusListeners.add(set);
    return () => {
      statusListeners.delete(set);
    };
  }, []);
  return s;
}
