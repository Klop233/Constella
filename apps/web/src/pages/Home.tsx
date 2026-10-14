import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ApprovalCard } from "../components/ApprovalCard";
import { IncidentCard } from "../components/IncidentCard";
import { InstanceThumb } from "../components/InstanceThumb";
import { AgentAvatar, AgentStatus } from "../components/AgentBits";
import { Badge, Card, Empty, Header, IconButton, Loading, Section, Sheet, cx } from "../components/ui";
import { api } from "../lib/api";
import { KIND_INFO } from "../lib/instances";
import { STATUS_TEXT, statusTone, timeAgo } from "../lib/format";
import { useLiveStatus } from "../lib/live";
import { useModelLabel } from "../lib/models";
import type { Overview } from "../lib/types";

export default function Home() {
  const nav = useNavigate();
  const modelLabel = useModelLabel();
  const qc = useQueryClient();
  const live = useLiveStatus();
  const [inbox, setInbox] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview"), refetchInterval: 30_000 });
  const notes = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ id: string; title: string; body: string; url: string; created_at: string; read: number }[]>("/api/notifications"),
    enabled: inbox,
  });

  return (
    <div>
      <Header
        title={
          <span className="flex items-center gap-2">
            Constella
            <span title={live === "open" ? "实时连接正常" : "正在重连"} className={cx("size-2 rounded-full", live === "open" ? "bg-[var(--ok)]" : "bg-[var(--warn)] pulse-dot")} />
          </span>
        }
        right={
          <IconButton
            label="通知"
            onClick={() => {
              setInbox(true);
              void api.post("/api/notifications/read").then(() => qc.invalidateQueries({ queryKey: ["overview"] }));
            }}
            className="relative"
          >
            <Bell className="size-4" />
            {!!data?.unread && <span className="absolute top-2 right-2 size-2 rounded-full bg-[var(--danger)]" />}
          </IconButton>
        }
      />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="px-4 space-y-5 pb-6">
          {data.approvals.length > 0 && (
            <Section title={`${approvalsTitle(data.approvals.map((a) => a.kind))} · ${data.approvals.length}`}>
              <div className="space-y-3">
                {data.approvals.map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              </div>
            </Section>
          )}

          {data.incidents.length > 0 && (
            <Section
              title={`需要你处理 · ${data.incidents.length}`}
              action={
                <button className="text-xs text-muted hover:text-[var(--text)]" onClick={() => nav("/audit")}>
                  审计记录
                </button>
              }
            >
              <div className="space-y-3">
                {data.incidents.slice(0, 3).map((i) => (
                  <IncidentCard key={i.id} incident={i} />
                ))}
              </div>
            </Section>
          )}

          <Section
            title="我的 agent"
            action={
              <button className="text-xs text-muted hover:text-[var(--text)] flex items-center gap-0.5" onClick={() => nav("/agents/new")}>
                <Plus className="size-4" /> 新建
              </button>
            }
          >
            {data.agents.length === 0 ? (
              <Card>
                <Empty title="还没有 agent" hint="从模板开始，几秒钟就能建好一个" action={<button className="text-accent font-medium" onClick={() => nav("/agents/new")}>新建 agent</button>} />
              </Card>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                {data.agents.map((a) => (
                  <Card key={a.id} className="p-3" onClick={() => nav(`/agents/${a.id}`)}>
                    <div className="flex items-start gap-2.5">
                      <AgentAvatar emoji={a.emoji} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{a.name}</div>
                        <AgentStatus agent={a} />
                      </div>
                    </div>
                    <div className="mt-2.5 text-xs text-muted truncate">{modelLabel(a.model)}</div>
                  </Card>
                ))}
              </div>
            )}
          </Section>

          {data.desktops.length > 0 && (
            <Section title="桌面" action={<button className="text-xs text-muted hover:text-[var(--text)]" onClick={() => nav("/desktops")}>全部</button>}>
              <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4">
                {data.desktops.map((d) => (
                  <Card key={d.id} className="w-44 lg:w-64 shrink-0 overflow-hidden" onClick={() => nav(`/desktops/${d.id}`)}>
                    <InstanceThumb d={d} width={360} className="aspect-[16/10]" />
                    <div className="px-3 py-2 text-sm truncate flex items-center gap-1.5">
                      {(() => {
                        const Icon = KIND_INFO[d.kind].icon;
                        return <Icon className="size-3.5 text-muted shrink-0" />;
                      })()}
                      <span className="truncate">{d.name}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          <Section title="最近对话">
            {data.conversations.length === 0 ? (
              <Card>
                <Empty title="还没有对话" hint="点开一个 agent 给它派活" />
              </Card>
            ) : (
              <Card className="divide-y divide-[var(--border)] overflow-hidden">
                {data.conversations.map((c) => (
                  <div key={c.id} className="flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-surface-2 active:bg-surface-2 cursor-pointer" onClick={() => nav(`/c/${c.id}`)}>
                    <AgentAvatar emoji={c.agent_emoji ?? "✨"} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{c.title}</div>
                      <div className="text-xs text-muted truncate">
                        {c.agent_name} · {timeAgo(c.updated_at)}
                        {c.source === "schedule" && " · 定时"}
                      </div>
                    </div>
                    {c.last_status && c.last_status !== "done" && <Badge tone={statusTone(c.last_status)}>{STATUS_TEXT[c.last_status]}</Badge>}
                  </div>
                ))}
              </Card>
            )}
          </Section>
        </div>
      )}
      <Sheet open={inbox} onClose={() => setInbox(false)} title="通知">
        {notes.isLoading ? (
          <Loading />
        ) : !notes.data?.length ? (
          <Empty title="没有通知" />
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {notes.data.map((n) => (
              <div
                key={n.id}
                className="py-3 cursor-pointer"
                onClick={() => {
                  setInbox(false);
                  if (n.url) nav(n.url);
                }}
              >
                <div className="flex gap-2">
                  <div className="font-medium flex-1">{n.title}</div>
                  <div className="text-xs text-muted">{timeAgo(n.created_at)}</div>
                </div>
                <div className="text-sm text-muted mt-0.5 line-clamp-2">{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** Approvals and the agents' questions share one list; name it after what's in it. */
function approvalsTitle(kinds: string[]): string {
  const questions = kinds.filter((k) => k === "decision").length;
  return questions === 0 ? "待审批" : questions === kinds.length ? "需要你选择" : "待审批和选择";
}
