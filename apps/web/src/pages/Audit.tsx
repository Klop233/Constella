import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { AuditDetailSheet } from "../components/AuditDetail";
import { INCIDENT_KIND, IncidentCard, IncidentIcon, IncidentStatus } from "../components/IncidentCard";
import { Empty, Header, Loading, Sheet, Tabs } from "../components/ui";
import { api } from "../lib/api";
import { AUDIT_ACTION, auditActor, auditSummary } from "../lib/audit";
import { clock, timeAgo } from "../lib/format";
import type { Agent, AuditEntry, Incident } from "../lib/types";

type View = "open" | "all" | "log";

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("open");
  const [entry, setEntry] = useState<AuditEntry | null>(null);
  const openId = params.get("id");
  const all = useQuery({ queryKey: ["incidents", "all"], queryFn: () => api.get<Incident[]>("/api/incidents?status=all&limit=200") });
  const log = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditEntry[]>("/api/audit?limit=300"), enabled: view === "log" });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents"), enabled: view === "log" });
  const linked = useQuery({ queryKey: ["incidents", openId], queryFn: () => api.get<Incident>(`/api/incidents/${openId}`), enabled: !!openId });
  const open = (all.data ?? []).filter((i) => i.status === "open" || i.status === "analyzing");
  const close = () => setParams({}, { replace: true });

  return (
    <div className="lg:max-w-3xl">
      <Header title="审计" sub="出错、卡住和系统自动处理的记录；需要你决定的可以直接采用方案" />
      <div className="px-4 pb-8 space-y-4">
        <Tabs
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: "待处理", count: open.length || undefined },
            { value: "all", label: "全部记录" },
            { value: "log", label: "操作日志" },
          ]}
        />
        {view !== "log" && all.isLoading ? (
          <Loading />
        ) : view === "open" ? (
          open.length ? (
            <div className="space-y-3">
              {open.map((i) => (
                <IncidentCard key={i.id} incident={i} />
              ))}
            </div>
          ) : (
            <Empty icon={<ClipboardCheck className="size-6" />} title="没有需要你处理的事" hint="任务出错或卡住时系统会先自己处理；处理不了的会在这里给出方案" />
          )
        ) : view === "all" ? (
          all.data?.length ? (
            <div className="divide-y divide-[var(--border)]">
              {all.data.map((i) => (
                <button key={i.id} type="button" onClick={() => setParams({ id: i.id }, { replace: true })} className="w-full flex items-center gap-2.5 py-2.5 -mx-2 px-2 rounded-md text-left hover:bg-surface-2">
                  <IncidentIcon incident={i} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13.5px] truncate">{i.title}</span>
                    <span className="block text-xs text-muted truncate">
                      {i.agent_emoji} {i.agent_name ?? "—"} · {INCIDENT_KIND[i.kind]} · {timeAgo(i.created_at)}
                    </span>
                  </span>
                  <IncidentStatus incident={i} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title="还没有记录" hint="任务出错、卡住或被自动修复时，会在这里留下记录" />
          )
        ) : log.isLoading ? (
          <Loading />
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {(log.data ?? []).map((e) => {
              const summary = auditSummary(e);
              return (
                <button key={e.id} type="button" onClick={() => setEntry(e)} className="w-full py-2 -mx-2 px-2 rounded-md flex items-baseline gap-3 text-[13px] text-left hover:bg-surface-2">
                  <span className="w-24 shrink-0 text-xs text-muted tabular-nums">{clock(e.ts)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate">{AUDIT_ACTION[e.action] ?? <span className="font-mono text-[12.5px]">{e.action}</span>}</span>
                      <span className="text-xs text-muted shrink-0">{auditActor(e.actor, agents.data)}</span>
                    </span>
                    {summary && <span className="block text-xs text-muted truncate">{summary}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <AuditDetailSheet entry={entry} agents={agents.data} onClose={() => setEntry(null)} />
      <Sheet open={!!openId} onClose={close} title="记录详情">
        {linked.data ? <IncidentCard incident={linked.data} className="border-0 p-0" onChanged={() => void linked.refetch()} /> : linked.isError ? <Empty title="这条记录不存在" /> : <Loading />}
      </Sheet>
    </div>
  );
}
