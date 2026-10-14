import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../lib/api";
import {
  APPROVAL_KIND,
  APPROVAL_STATUS,
  auditAction,
  auditActor,
  auditChanges,
  auditDetail,
  auditValue,
  auditVia,
  detailKeyLabel,
  fieldLabel,
  INCIDENT_STATUS,
} from "../lib/audit";
import { describeCron, fullTime, STATUS_TEXT, timeAgo } from "../lib/format";
import type { Agent, AuditEntry, AuditEntryDetail } from "../lib/types";
import { Badge, Loading, Section, Sheet, cx } from "./ui";

function Kv({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="py-2 flex gap-3">
      <dt className="w-24 shrink-0 text-xs text-muted pt-0.5">{label}</dt>
      <dd className={cx("flex-1 min-w-0 text-[13px] break-words", mono && "font-mono text-[12.5px] break-all")}>{children}</dd>
    </div>
  );
}

/** Command / question / prompt text: kept as written, wrapped, selectable. */
function Block({ children }: { children: string }) {
  return <pre className="font-mono text-[12.5px] bg-surface-2 rounded-lg px-2.5 py-2 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{children}</pre>;
}

/** Detail keys the sections above already cover (or that are shown as the changes list). */
const COVERED = new Set(["via", "changes"]);

/**
 * Everything recorded about one entry: when, who, from which device, what it was about (ids resolved to names and
 * commands), what changed from what to what, and the raw record. The lists only show a line of this.
 */
export function AuditDetailSheet({ entry, agents = [], onClose }: { entry: AuditEntry | null; agents?: Pick<Agent, "id" | "name">[]; onClose: () => void }) {
  const full = useQuery({
    queryKey: ["audit", "entry", entry?.id],
    queryFn: () => api.get<AuditEntryDetail>(`/api/audit/${entry!.id}`),
    enabled: !!entry,
  });
  return (
    <Sheet open={!!entry} onClose={onClose} title={entry ? auditAction(entry.action) : ""}>
      {entry && <Body entry={entry} refs={full.data?.refs} loading={full.isLoading} agents={agents} />}
    </Sheet>
  );
}

function Body({ entry, refs, loading, agents }: { entry: AuditEntry; refs: AuditEntryDetail["refs"] | undefined; loading: boolean; agents: Pick<Agent, "id" | "name">[] }) {
  const d = auditDetail(entry.detail);
  const via = auditVia(d);
  const changes = auditChanges(d);
  const who = auditActor(entry.actor, agents);
  const ip = via?.ip ?? (typeof d.ip === "string" ? d.ip : null);
  const source = [via?.device, ip].filter(Boolean).join(" · ");
  const r = refs ?? {};

  // Whatever the detail still has to say once the resolved objects and the changes are shown.
  const hidden = new Set(COVERED);
  if (changes.length) hidden.add("fields");
  if (typeof d.ip === "string") hidden.add("ip");
  if (r.approval) hidden.add("approvalId");
  if (r.run) hidden.add("runId");
  if (r.conversation) hidden.add("conversationId");
  if (r.agent) hidden.add("agentId");
  if (r.agent || r.schedule || r.desktop || r.incident || r.artifact) {
    hidden.add("id");
    hidden.add("name");
  }
  const rest = Object.entries(d).filter(([k, v]) => !hidden.has(k) && v !== null && v !== undefined && v !== "");
  const hasObject = r.agent || r.conversation || r.run || r.approval || r.schedule || r.desktop || r.incident || r.artifact;

  return (
    <div className="space-y-5">
      <dl className="divide-y divide-[var(--border)]">
        <Kv label="时间">
          <span className="tabular-nums">{fullTime(entry.ts)}</span>
          <span className="text-muted"> · {timeAgo(entry.ts)}</span>
        </Kv>
        <Kv label="执行者">
          {who}
          {who !== entry.actor && <span className="block font-mono text-[11.5px] text-muted break-all">{entry.actor}</span>}
        </Kv>
        {source && <Kv label="来源">{source}</Kv>}
      </dl>

      {loading && !refs ? (
        <Loading />
      ) : (
        hasObject && (
          <Section title="涉及">
            <dl className="divide-y divide-[var(--border)]">
              {r.agent && (
                <Kv label="agent">
                  <Link to={`/agents/${r.agent.id}`} className="hover:underline">
                    {r.agent.emoji} {r.agent.name}
                  </Link>
                  {r.agent.archived && <span className="text-muted"> · 已删除</span>}
                </Kv>
              )}
              {r.conversation && (
                <Kv label="对话">
                  <Link to={`/c/${r.conversation.id}`} className="hover:underline">
                    {r.conversation.title}
                  </Link>
                </Kv>
              )}
              {r.run && (
                <>
                  <Kv label="任务">{r.run.prompt}</Kv>
                  <Kv label="任务状态">
                    {STATUS_TEXT[r.run.status] ?? r.run.status}
                    <span className="text-muted"> · {r.run.model} · {fullTime(r.run.created_at)}</span>
                  </Kv>
                  {r.run.error && <Kv label="任务错误">{r.run.error}</Kv>}
                </>
              )}
              {r.approval && (
                <>
                  <Kv label="审批内容">
                    <span className="text-muted text-xs">{APPROVAL_KIND[r.approval.kind] ?? r.approval.kind}</span>
                    <Block>{r.approval.summary}</Block>
                    {r.approval.detail && <Block>{r.approval.detail}</Block>}
                  </Kv>
                  <Kv label="审批结果">
                    {APPROVAL_STATUS[r.approval.status] ?? r.approval.status}
                    <span className="text-muted">
                      {" "}
                      · 提出 {fullTime(r.approval.created_at)}
                      {r.approval.resolved_at && ` · 处理 ${fullTime(r.approval.resolved_at)}`}
                    </span>
                  </Kv>
                  {r.approval.answer && <Kv label="回答">{r.approval.answer}</Kv>}
                </>
              )}
              {r.schedule && (
                <Kv label="定时任务">
                  {r.schedule.name}
                  <span className="text-muted">
                    {" "}
                    · {describeCron(r.schedule.cron)} · {r.schedule.enabled ? "已启用" : "已停用"}
                  </span>
                </Kv>
              )}
              {r.desktop && (
                <Kv label="桌面">
                  <Link to={`/desktops/${r.desktop.id}`} className="hover:underline">
                    {r.desktop.name}
                  </Link>
                </Kv>
              )}
              {r.artifact && (
                <Kv label="成果">
                  <Link to={`/artifacts?artifact=${r.artifact.id}`} className="hover:underline">
                    {r.artifact.title}
                  </Link>
                  <span className="text-muted">
                    {" "}
                    · {r.artifact.filename} · v{r.artifact.version}
                  </span>
                </Kv>
              )}
              {r.incident && (
                <Kv label="诊断报告">
                  <Link to={`/audit?id=${r.incident.id}`} className="hover:underline">
                    {r.incident.title}
                  </Link>
                  <Badge className="ml-1.5">{INCIDENT_STATUS[r.incident.status] ?? r.incident.status}</Badge>
                </Kv>
              )}
            </dl>
          </Section>
        )
      )}

      {changes.length > 0 && (
        <Section title="变更">
          <dl className="divide-y divide-[var(--border)]">
            {changes.map(([key, c]) => (
              <Kv key={key} label={fieldLabel(key)}>
                {c.secret ? (
                  c.to ? "已设置新值（不记录内容）" : "已清除"
                ) : (
                  <>
                    <span className="text-muted">{auditValue(c.from, key)}</span>
                    <span className="text-muted"> → </span>
                    {auditValue(c.to, key)}
                  </>
                )}
              </Kv>
            ))}
          </dl>
        </Section>
      )}

      {rest.length > 0 && (
        <Section title="详情">
          <dl className="divide-y divide-[var(--border)]">
            {rest.map(([k, v]) => (
              <Kv key={k} label={k === "fields" ? "修改了" : detailKeyLabel(k)} mono={/Id$|^id$|^ref$/.test(k)}>
                {k === "fields" ? [...new Set((v as string[]).map(fieldLabel))].join("、") : typeof v === "string" && v.length > 120 ? <Block>{v}</Block> : auditValue(v)}
              </Kv>
            ))}
          </dl>
        </Section>
      )}

      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">原始记录 · #{entry.id}</summary>
        <div className="mt-2 space-y-1.5">
          <div className="font-mono break-all">{entry.action}</div>
          {entry.detail && <Block>{prettyJson(entry.detail)}</Block>}
        </div>
      </details>
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
