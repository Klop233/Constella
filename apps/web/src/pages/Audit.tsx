import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { INCIDENT_KIND, IncidentCard, IncidentIcon, IncidentStatus } from "../components/IncidentCard";
import { Empty, Header, Loading, Sheet, Tabs } from "../components/ui";
import { api } from "../lib/api";
import { clock, timeAgo } from "../lib/format";
import type { AuditEntry, Incident } from "../lib/types";

type View = "open" | "all" | "log";

/** Readable names for audit actions; unknown ones show as-is. */
const ACTION: Record<string, string> = {
  "runner.start_failed": "任务启动失败",
  "runner.repair": "修复 runner（重建容器）",
  "runner.repaired": "修复成功，任务继续",
  "runner.repair_failed": "修复后仍无法启动",
  "run.auto_resume": "安排自动继续",
  "run.auto_resume_stalled": "自动继续没有进展，已暂停",
  "run.interrupt": "停止任务",
  "incident.start_failure": "记录启动失败",
  "incident.engine_error": "出错，生成诊断报告",
  "incident.stalled": "停滞，生成诊断报告",
  "incident.stuck": "记录任务卡住",
  "incident.diagnosed": "诊断完成",
  "incident.adopt": "采用方案",
  "incident.dismiss": "忽略报告",
  "supervisor.wait": "监督员：继续等待",
  "supervisor.kill": "监督员：结束卡住的进程",
  "supervisor.hint": "监督员：提醒 agent",
  "supervisor.restart": "监督员：重启这一轮",
  "supervisor.rebuild": "监督员：重建 agent 容器",
  "runner.revive_failed": "runner 没能自己恢复",
  "supervisor.escalate": "监督员：请你决定",
  "decision.answer": "回答 agent 的问题",
  "decision.dismiss": "让 agent 自己判断",
  "approval.approve": "批准",
  "approval.deny": "拒绝",
  "agent.create": "新建 agent",
  "artifact.rename": "重命名成果",
  "artifact.edit": "编辑成果",
  "artifact.restore": "恢复成果的旧版本",
  "artifact.delete": "删除成果",
  "agent.update": "修改 agent",
  "agent.archive": "删除 agent",
  "settings.update": "修改设置",
  "auth.login": "登录",
  "auth.setup": "初始化账户",
  "desktop.takeover": "接管桌面",
  "desktop.handback": "交还桌面",
};

const ACTOR: Record<string, string> = { system: "系统", supervisor: "监督员", watchdog: "看门狗", policy: "审批策略" };

/** The few detail fields worth reading in a list; everything else stays in the raw JSON. */
function detailText(detail: string | null): string {
  if (!detail) return "";
  try {
    const d = JSON.parse(detail) as Record<string, unknown>;
    const keys = ["assessment", "did", "reason", "error", "option", "answer", "title", "fields", "name"];
    const parts = keys.filter((k) => d[k] != null && d[k] !== "").map((k) => (Array.isArray(d[k]) ? (d[k] as unknown[]).join("、") : String(d[k])));
    // Ids alone mean nothing to the owner; the readable action name says enough.
    return parts.join(" · ");
  } catch {
    return detail;
  }
}

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("open");
  const openId = params.get("id");
  const all = useQuery({ queryKey: ["incidents", "all"], queryFn: () => api.get<Incident[]>("/api/incidents?status=all&limit=200") });
  const log = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditEntry[]>("/api/audit?limit=300"), enabled: view === "log" });
  const linked = useQuery({ queryKey: ["incidents", openId], queryFn: () => api.get<Incident>(`/api/incidents/${openId}`), enabled: !!openId });
  const open = (all.data ?? []).filter((i) => i.status === "open" || i.status === "analyzing");
  const close = () => setParams({}, { replace: true });

  return (
    <div>
      <Header title="审计" sub="出错、卡住和系统自动处理的记录；需要你决定的可以直接采用方案" />
      <div className="px-4 pb-8 space-y-4 lg:max-w-3xl">
        <Tabs
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: open.length ? `待处理 ${open.length}` : "待处理" },
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
            {(log.data ?? []).map((e) => (
              <div key={e.id} className="py-2 flex items-baseline gap-3 text-[13px]">
                <span className="w-24 shrink-0 text-xs text-muted tabular-nums">{clock(e.ts)}</span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate">{ACTION[e.action] ?? <span className="font-mono text-[12.5px]">{e.action}</span>}</span>
                    <span className="text-xs text-muted shrink-0">{ACTOR[e.actor] ?? (e.actor.startsWith("agent:") ? "agent" : "你")}</span>
                  </span>
                  {detailText(e.detail) && <span className="block text-xs text-muted truncate">{detailText(e.detail)}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <Sheet open={!!openId} onClose={close} title="记录详情">
        {linked.data ? <IncidentCard incident={linked.data} className="border-0 p-0" onChanged={() => void linked.refetch()} /> : linked.isError ? <Empty title="这条记录不存在" /> : <Loading />}
      </Sheet>
    </div>
  );
}
