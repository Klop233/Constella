import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Empty, Field, Header, IconButton, Loading, Section, Segmented, Sheet, Toggle, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { clock, describeCron, timeAgo } from "../lib/format";
import type { Agent, Schedule } from "../lib/types";

const PRESETS = [
  { label: "每天 8:00", cron: "0 8 * * *" },
  { label: "每天 20:00", cron: "0 20 * * *" },
  { label: "工作日 9:00", cron: "0 9 * * 1-5" },
  { label: "每周一 9:00", cron: "0 9 * * 1" },
  { label: "每小时", cron: "0 * * * *" },
];

export default function Tasks() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules"], queryFn: () => api.get<Schedule[]>("/api/schedules") });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const [edit, setEdit] = useState<Partial<Schedule> | null>(null);
  const [history, setHistory] = useState<Schedule | null>(null);
  const hist = useQuery({
    queryKey: ["schedules", "history", history?.id],
    queryFn: () => api.get<{ id: string; fired_at: string; ok: number; detail: string | null }[]>(`/api/schedules/${history!.id}/history`),
    enabled: !!history,
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const body = {
        name: edit.name,
        cron: edit.cron,
        kind: edit.kind,
        agentId: edit.kind === "agent_prompt" ? edit.agent_id : (edit.agent_id ?? null),
        payload: edit.kind === "notify" ? { title: edit.name ?? "提醒", body: edit.payload?.body ?? "" } : { text: edit.payload?.text ?? "" },
      };
      if (edit.id) await api.patch(`/api/schedules/${edit.id}`, body);
      else await api.post("/api/schedules", body);
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ["schedules"] });
      toast("已保存");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  const user = list.data?.filter((s) => s.kind !== "system") ?? [];
  const system = list.data?.filter((s) => s.kind === "system") ?? [];
  const agentName = (id: string | null) => agents.data?.find((a) => a.id === id);

  return (
    <div>
      <Header
        title="任务"
        sub="定时提醒和定时让 agent 干活"
        right={
          <IconButton label="新建" onClick={() => setEdit({ kind: "notify", cron: "0 8 * * *", name: "", payload: { body: "" } })}>
            <Plus className="size-5" />
          </IconButton>
        }
      />
      <div className="px-4 space-y-5 pb-6 lg:max-w-3xl">
        {list.isLoading ? (
          <Loading />
        ) : (
          <>
            <Section title="定时任务">
              {user.length === 0 ? (
                <Card>
                  <Empty icon={<CalendarClock className="size-9" />} title="还没有定时任务" hint="也可以直接对 agent 说「每天早上 8 点提醒我吃药」" />
                </Card>
              ) : (
                <div className="space-y-2.5">
                  {user.map((s) => {
                    const a = agentName(s.agent_id);
                    return (
                      <Card key={s.id} className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0" onClick={() => setEdit(s)}>
                            <div className="font-medium truncate">{s.name}</div>
                            <div className="text-sm text-muted mt-0.5">
                              {describeCron(s.cron)} · {s.kind === "notify" ? "推送提醒" : `${a?.emoji ?? ""} ${a?.name ?? "agent"} 执行`}
                            </div>
                            <div className="text-xs text-muted mt-1 truncate">{s.kind === "notify" ? s.payload.body : s.payload.text}</div>
                          </div>
                          <Toggle
                            checked={!!s.enabled}
                            label="启用"
                            onChange={(v) => void api.patch(`/api/schedules/${s.id}`, { enabled: v }).then(() => qc.invalidateQueries({ queryKey: ["schedules"] }))}
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-3 text-xs text-muted">
                          <span className="flex-1">
                            {s.enabled && s.next_run ? `下次 ${clock(s.next_run)}` : "已停用"}
                            {s.last && (
                              <button className="ml-2 underline" onClick={() => setHistory(s)}>
                                上次 {timeAgo(s.last.fired_at)} {s.last.ok ? "✓" : "✗"}
                              </button>
                            )}
                          </span>
                          <button
                            className="flex items-center gap-1 text-accent"
                            onClick={() => void api.post<{ ok: boolean; detail?: string }>(`/api/schedules/${s.id}/run`).then((r) => toast(r.ok ? `已执行 ${r.detail ?? ""}` : `失败：${r.detail}`, r.ok ? "ok" : "danger"))}
                          >
                            <Play className="size-3.5" /> 立即运行
                          </button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </Section>
            <Section title="系统任务">
              <Card className="divide-y divide-[var(--border)] overflow-hidden">
                {system.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0" onClick={() => setHistory(s)}>
                      <div className="truncate">{s.name}</div>
                      <div className="text-xs text-muted">
                        {describeCron(s.cron)}
                        {s.last && ` · 上次 ${timeAgo(s.last.fired_at)} ${s.last.ok ? "✓" : "✗"}`}
                      </div>
                    </div>
                    <Toggle checked={!!s.enabled} label="启用" onChange={(v) => void api.patch(`/api/schedules/${s.id}`, { enabled: v }).then(() => qc.invalidateQueries({ queryKey: ["schedules"] }))} />
                  </div>
                ))}
              </Card>
            </Section>
          </>
        )}
      </div>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "编辑任务" : "新建任务"}>
        {edit && (
          <div className="space-y-4">
            {!edit.id && (
              <Segmented
                value={edit.kind as "notify" | "agent_prompt"}
                onChange={(k) => setEdit({ ...edit, kind: k, agent_id: k === "agent_prompt" ? (agents.data?.[0]?.id ?? null) : null })}
                options={[
                  { value: "notify", label: "推送提醒" },
                  { value: "agent_prompt", label: "让 agent 执行" },
                ]}
              />
            )}
            <Field label="名称">
              <input className={inputClass} value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} placeholder="例如：早晨吃药" />
            </Field>
            <Field group label="时间" hint={`${describeCron(edit.cron ?? "")}（北京时间，cron 格式：分 时 日 月 周）`}>
              <div className="flex gap-1.5 flex-wrap mb-2">
                {PRESETS.map((p) => (
                  <button key={p.cron} type="button" onClick={() => setEdit({ ...edit, cron: p.cron })} className={cx("text-xs px-2.5 py-1 rounded-md border", edit.cron === p.cron ? "bg-[var(--text)] text-[var(--bg)] border-transparent" : "bg-surface border-line")}>
                    {p.label}
                  </button>
                ))}
              </div>
              <input aria-label="cron 表达式" className={cx(inputClass, "font-mono")} value={edit.cron ?? ""} onChange={(e) => setEdit({ ...edit, cron: e.target.value })} />
            </Field>
            {edit.kind === "notify" ? (
              <Field label="提醒内容">
                <textarea className={cx(inputClass, "min-h-20")} value={edit.payload?.body ?? ""} onChange={(e) => setEdit({ ...edit, payload: { ...edit.payload, body: e.target.value } })} />
              </Field>
            ) : (
              <>
                <Field label="由哪个 agent 执行">
                  <select className={inputClass} value={edit.agent_id ?? ""} onChange={(e) => setEdit({ ...edit, agent_id: e.target.value })} disabled={!!edit.id}>
                    {agents.data?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.emoji} {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="要它做什么">
                  <textarea className={cx(inputClass, "min-h-24")} value={edit.payload?.text ?? ""} onChange={(e) => setEdit({ ...edit, payload: { ...edit.payload, text: e.target.value } })} placeholder="例如：汇总昨天的服务器状态，有异常就通知我" />
                </Field>
              </>
            )}
            <div className="flex gap-2">
              {edit.id && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (!confirm("删除这个任务？")) return;
                    void api.del(`/api/schedules/${edit.id}`).then(() => {
                      setEdit(null);
                      void qc.invalidateQueries({ queryKey: ["schedules"] });
                    });
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
              <Button variant="primary" className="flex-1" loading={busy} onClick={save} disabled={!edit.name || !edit.cron}>
                保存
              </Button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={!!history} onClose={() => setHistory(null)} title={`执行记录 · ${history?.name ?? ""}`}>
        {hist.isLoading ? (
          <Loading />
        ) : !hist.data?.length ? (
          <Empty title="还没有执行过" />
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {hist.data.map((h) => (
              <div key={h.id} className="py-2.5 flex items-center gap-2 text-sm">
                <Badge tone={h.ok ? "ok" : "danger"}>{h.ok ? "成功" : "失败"}</Badge>
                <span className="text-muted">{clock(h.fired_at)}</span>
                <span className="truncate flex-1 text-xs text-muted">{h.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
