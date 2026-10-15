import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Eye, LifeBuoy, Loader2, Monitor, Siren, Stethoscope, Wrench } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Incident } from "../lib/types";
import { Badge, Button, Card, cx, StatusText, toast } from "./ui";

export const INCIDENT_KIND: Record<Incident["kind"], string> = {
  start_failure: "启动失败",
  engine_error: "出错",
  stalled: "自动继续停下",
  stuck: "卡住",
  panic: "Panic",
  instance: "实例故障",
  help: "求助",
};

/** What the collapsed `error` holds for kinds where it isn't an error message. */
const DETAIL_LABEL: Partial<Record<Incident["kind"], string>> = { instance: "诊断详情", help: "求助原文", panic: "agent 最后的回复" };

const KIND_ICON: Record<Incident["kind"], typeof Eye> = {
  start_failure: Wrench,
  engine_error: Stethoscope,
  stalled: Stethoscope,
  stuck: Eye,
  panic: Siren,
  instance: Monitor,
  help: LifeBuoy,
};

const STATUS: Record<Incident["status"], { label: string; tone: "warn" | "muted" | "ok" | "busy" }> = {
  analyzing: { label: "分析中", tone: "busy" },
  open: { label: "待处理", tone: "warn" },
  auto: { label: "已自动处理", tone: "ok" },
  adopted: { label: "已采用方案", tone: "ok" },
  dismissed: { label: "已忽略", tone: "muted" },
};

export function IncidentIcon({ incident, className }: { incident: Pick<Incident, "kind" | "status">; className?: string }) {
  const Icon = KIND_ICON[incident.kind] ?? Stethoscope;
  return <Icon className={cx("size-4 shrink-0", incident.status === "open" || incident.status === "analyzing" ? "text-warn" : "text-muted", className)} />;
}

/** Where a report stands, as quiet status text (分析中 / 待处理 / 已采用方案…). */
export function IncidentStatus({ incident }: { incident: Pick<Incident, "status"> }) {
  const s = STATUS[incident.status];
  return <StatusText tone={s.tone}>{s.label}</StatusText>;
}

/**
 * A diagnosis report or a supervisor's question: what happened, what the hub already did, and options the
 * owner can adopt in one tap. Resolved ones show how they ended.
 */
export function IncidentCard({ incident, showAgent = true, showLink = true, className, onChanged }: { incident: Incident; showAgent?: boolean; showLink?: boolean; className?: string; onChanged?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | "dismiss" | null>(null);
  const [showError, setShowError] = useState(false);
  const pending = incident.status === "open" || incident.status === "analyzing";
  const act = async (what: number | "dismiss") => {
    setBusy(what);
    try {
      if (what === "dismiss") await api.post(`/api/incidents/${incident.id}/dismiss`);
      else await api.post(`/api/incidents/${incident.id}/adopt`, { index: what });
      toast(what === "dismiss" ? "已忽略" : `已采用「${incident.options[what]?.title}」`);
      void qc.invalidateQueries({ queryKey: ["incidents"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className={cx("p-3.5", pending && "border-[color-mix(in_oklab,var(--warn)_45%,transparent)]", className)}>
      <div className="flex items-center gap-2 text-sm min-w-0">
        <IncidentIcon incident={incident} />
        <span className="font-medium truncate">{incident.title}</span>
        {showAgent && incident.agent_name && (
          <span className="text-muted truncate hidden sm:inline">
            · {incident.agent_emoji} {incident.agent_name}
          </span>
        )}
        {showAgent && !incident.agent_name && incident.desktop_name && <span className="text-muted truncate hidden sm:inline">· {incident.desktop_name}</span>}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted">{timeAgo(incident.created_at)}</span>
          <IncidentStatus incident={incident} />
        </span>
      </div>

      {incident.status === "analyzing" ? (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 className="size-3.5 animate-spin" /> 诊断员正在分析原因，稍等…
        </div>
      ) : (
        <div className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap">{incident.summary}</div>
      )}

      {incident.actions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {incident.actions.map((a) => (
            <li key={a} className="flex items-start gap-1.5 text-xs text-muted">
              <Check className="size-3.5 mt-px shrink-0" /> {a}
            </li>
          ))}
        </ul>
      )}

      {incident.error && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowError(!showError)} className="flex items-center gap-1 text-xs text-muted hover:text-[var(--text)]">
            {DETAIL_LABEL[incident.kind] ?? "错误信息"} <ChevronRight className={cx("size-3.5 transition", showError && "rotate-90")} />
          </button>
          {showError && <pre className="mt-1 text-xs font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-lg p-2.5 max-h-48 overflow-auto">{incident.error}</pre>}
        </div>
      )}

      {incident.status === "open" && incident.options.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-xs text-muted">可以直接采用的方案</div>
          {incident.options.map((o, i) => (
            <div key={`${i}-${o.title}`} className={cx("flex items-center gap-3 rounded-lg border px-3 py-2", i === incident.recommended ? "border-[color-mix(in_oklab,var(--color-accent)_45%,transparent)]" : "border-line")}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                  <span className="truncate">{o.title}</span>
                  {i === incident.recommended && <Badge tone="accent">推荐</Badge>}
                </div>
                {o.detail && <div className="text-xs text-muted mt-0.5">{o.detail}</div>}
              </div>
              <Button size="sm" variant={i === incident.recommended ? "primary" : "soft"} loading={busy === i} disabled={busy !== null} onClick={() => void act(i)}>
                采用
              </Button>
            </div>
          ))}
        </div>
      )}

      {(pending || (showLink && (incident.conversation_id || incident.desktop_id)) || incident.resolution) && (
        <div className="mt-2.5 flex items-center gap-3 text-xs text-muted">
          {pending ? (
            <button type="button" disabled={busy !== null} onClick={() => void act("dismiss")} className="hover:text-[var(--text)] disabled:opacity-50">
              {busy === "dismiss" ? "处理中…" : "忽略"}
            </button>
          ) : (
            incident.resolution && (
              <span className="truncate">
                {incident.status === "adopted" ? `采用了「${incident.resolution}」` : incident.resolution}
                {incident.resolved_at && ` · ${timeAgo(incident.resolved_at)}`}
              </span>
            )
          )}
          {showLink && (incident.conversation_id || incident.desktop_id) && (
            <span className="ml-auto flex items-center gap-3 shrink-0">
              {incident.desktop_id && incident.desktop_name && (
                <Link to={`/instances/${incident.desktop_id}`} className="hover:text-[var(--text)]">
                  查看实例 ›
                </Link>
              )}
              {incident.conversation_id && (
                <Link to={`/c/${incident.conversation_id}`} className="hover:text-[var(--text)]">
                  查看对话 ›
                </Link>
              )}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
