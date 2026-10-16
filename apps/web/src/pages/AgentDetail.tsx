import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MessageSquarePlus, Pencil, RotateCcw, Share2, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar, AgentStatus, RunStatus } from "../components/AgentBits";
import { ArtifactRows } from "../components/ArtifactList";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Card, confirmDialog, Empty, Field, Header, IconButton, Loading, Row, Section, SectionLink, Segmented, SettingGroup, SettingRow, Sheet, Tabs, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useModelLabel } from "../lib/models";
import type { Agent, Artifact, Conversation, Skill } from "../lib/types";

export default function AgentDetail() {
  const { id } = useParams();
  const modelLabel = useModelLabel();
  const nav = useNavigate();
  const [tab, setTab] = useState<"chats" | "artifacts" | "knowledge" | "manage">("chats");
  const agent = useQuery({ queryKey: ["agent", id], queryFn: () => api.get<Agent>(`/api/agents/${id}`) });
  const a = agent.data;
  if (agent.isLoading) return <Loading />;
  if (!a) return <Empty title="找不到这个 agent" />;
  return (
    <div className="lg:max-w-3xl">
      <Header
        back="/"
        // On wide screens the name is right below, large; the bar keeps just the way back and edit.
        title={<span className="lg:hidden">{a.name}</span>}
        right={
          <IconButton label="编辑" onClick={() => nav(`/agents/${a.id}/edit`)}>
            <Pencil className="size-4" />
          </IconButton>
        }
      />
      <div className="px-4 space-y-5">
        <div className="flex items-center gap-3 lg:pt-2">
          <AgentAvatar emoji={a.emoji} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="font-display text-xl font-medium truncate">{a.name}</div>
            <AgentStatus agent={a} />
            <div className="text-xs text-muted mt-1 truncate">
              {modelLabel(a.model)} · {a.desktop_policy.desktopIds.length ? `实例 ${a.desktop_policy.desktopIds.length} 个` : "没有实例"}
              {a.host_access && " · 可操作宿主机"}
            </div>
          </div>
          <Button variant="primary" className="shrink-0" onClick={() => nav(`/agents/${a.id}/chat`)}>
            <MessageSquarePlus className="size-4" /> 新对话
          </Button>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "chats", label: "对话" },
            { value: "artifacts", label: "成果" },
            { value: "knowledge", label: "记忆与技能" },
            { value: "manage", label: "管理" },
          ]}
        />
        {tab === "chats" && <Chats agentId={a.id} />}
        {tab === "artifacts" && <AgentArtifacts agentId={a.id} />}
        {tab === "knowledge" && <Knowledge agentId={a.id} />}
        {tab === "manage" && <Manage agent={a} />}
      </div>
    </div>
  );
}

function AgentArtifacts({ agentId }: { agentId: string }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["artifacts", { agentId }], queryFn: () => api.get<Artifact[]>(`/api/artifacts?agentId=${agentId}&limit=50`) });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <Empty title="还没有成果" hint="它发给你的文件和写的文档会收在这里" />;
  return (
    <div className="space-y-1.5 mb-6">
      <ArtifactRows items={q.data} showAgent={false} />
      {q.data.length >= 50 && (
        <button className="px-1 text-xs text-muted hover:text-[var(--text)]" onClick={() => nav(`/artifacts?agent=${agentId}`)}>
          查看全部
        </button>
      )}
    </div>
  );
}

function Chats({ agentId }: { agentId: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [view, setView] = useState<"active" | "archived">("active");
  const archived = view === "archived";
  const q = useQuery({
    queryKey: ["conversations", agentId, view],
    queryFn: () => api.get<Conversation[]>(`/api/agents/${agentId}/conversations${archived ? "?archived=1" : ""}`),
  });
  const restore = async (c: Conversation) => {
    try {
      await api.patch(`/api/conversations/${c.id}`, { archived: false });
      toast("已取消归档");
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  return (
    <div className="space-y-3 mb-6">
      <div className="w-40">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "active", label: "进行中" },
            { value: "archived", label: "已归档" },
          ]}
        />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <Empty title={archived ? "没有归档的对话" : "还没有对话"} hint={archived ? "在对话里点归档图标，它就会收到这里" : undefined} />
      ) : (
        <Card className="divide-y divide-[var(--border)] overflow-hidden">
          {q.data.map((c) => (
            <Row
              key={c.id}
              title={c.title}
              sub={`${timeAgo(c.updated_at)}${c.source === "schedule" ? " · 定时任务" : ""}`}
              right={
                archived ? (
                  <button
                    className="text-xs text-muted hover:text-[var(--text)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      void restore(c);
                    }}
                  >
                    取消归档
                  </button>
                ) : (
                  <RunStatus status={c.last_status} />
                )
              }
              onClick={() => nav(`/c/${c.id}`)}
            />
          ))}
        </Card>
      )}
    </div>
  );
}

function Knowledge({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["knowledge", agentId],
    queryFn: () => api.get<{ memory: { agent: string; user: string }; skills: Skill[] }>(`/api/agents/${agentId}/knowledge`),
  });
  const [editing, setEditing] = useState<"agent" | "user" | null>(null);
  const [draft, setDraft] = useState("");
  const [skill, setSkill] = useState<{ skill: Skill; content: string } | null>(null);
  const [curating, setCurating] = useState(false);
  if (q.isLoading || !q.data) return <Loading />;
  const openSkill = async (s: Skill) => {
    const r = await api.get<{ content: string }>(`/api/agents/${agentId}/skills/${s.name}`);
    setSkill({ skill: s, content: r.content });
  };
  const saveMemory = async () => {
    try {
      await api.put(`/api/agents/${agentId}/memory`, { scope: editing, content: draft });
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
      toast("已保存（可在「学习」页撤销）");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  return (
    <div className="space-y-8 pb-6 pt-1">
      {(["agent", "user"] as const).map((scope) => (
        <Section
          key={scope}
          title={scope === "agent" ? "它的记忆" : "关于你（所有 agent 共享）"}
          action={
            <SectionLink
              onClick={() => {
                setDraft(q.data.memory[scope]);
                setEditing(scope);
              }}
            >
              编辑
            </SectionLink>
          }
        >
          <Card className="p-3 text-[13px]">
            {q.data.memory[scope].replace(/^#.*\n/, "").trim() ? <Markdown text={q.data.memory[scope].replace(/^#.*\n/, "")} /> : <div className="text-muted">暂无</div>}
          </Card>
        </Section>
      ))}
      <Section
        title={`技能 · ${q.data.skills.length}`}
        action={
          <SectionLink
            onClick={async () => {
              if (curating) return;
              setCurating(true);
              try {
                const r = await api.post<{ events: unknown[] }>(`/api/agents/${agentId}/curate`);
                toast(r.events.length ? `整理完成，${r.events.length} 处变更` : "无需整理");
                void qc.invalidateQueries({ queryKey: ["knowledge"] });
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), "danger");
              } finally {
                setCurating(false);
              }
            }}
          >
            <Sparkles className={cx(curating && "animate-pulse")} /> 整理
          </SectionLink>
        }
      >
        {q.data.skills.length === 0 ? (
          <Card>
            <Empty title="还没有技能" hint="完成多步任务后，它会自动把可复用的流程总结成技能" />
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--border)] overflow-hidden">
            {q.data.skills.map((s) => (
              <Row
                key={`${s.scope}:${s.name}`}
                title={
                  <span className="flex items-center gap-2">
                    {s.name}
                    {s.scope === "shared" && <Badge tone="accent">共享</Badge>}
                  </span>
                }
                sub={s.description}
                right={<span className="text-xs">{s.uses} 次</span>}
                onClick={() => openSkill(s)}
              />
            ))}
          </Card>
        )}
      </Section>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing === "agent" ? "编辑记忆" : "编辑用户画像"}>
        <textarea className={cx(inputClass, "min-h-72 font-mono text-sm")} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button variant="primary" className="w-full mt-3" onClick={saveMemory}>
          保存
        </Button>
      </Sheet>
      <Sheet open={!!skill} onClose={() => setSkill(null)} title={skill?.skill.name ?? ""}>
        {skill && (
          <div className="space-y-4">
            <div className="text-sm">
              <Markdown text={skill.content.replace(/^---[\s\S]*?---/, "")} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {skill.skill.scope === "agent" && (
                <Button
                  onClick={async () => {
                    await api.post(`/api/agents/${agentId}/skills/${skill.skill.name}/promote`);
                    toast("已共享给所有 agent");
                    setSkill(null);
                    void qc.invalidateQueries({ queryKey: ["knowledge"] });
                  }}
                >
                  <Share2 className="size-4" /> 共享
                </Button>
              )}
              <Button
                variant="danger"
                onClick={async () => {
                  if (!(await confirmDialog({ title: `删除技能「${skill.skill.name}」？`, body: "删除后可以在学习页撤销。", ok: "删除", danger: true }))) return;
                  await api.del(`/api/agents/${agentId}/skills/${skill.skill.name}?scope=${skill.skill.scope}`);
                  toast("已删除（可在学习页撤销）");
                  setSkill(null);
                  void qc.invalidateQueries({ queryKey: ["knowledge"] });
                }}
              >
                <Trash2 className="size-4" /> 删除
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Manage({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [secretOpen, setSecretOpen] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [busy, setBusy] = useState("");
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      void qc.invalidateQueries();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="space-y-8 pb-8 pt-1">
      <SettingGroup title="密钥">
        <SettingRow title="环境变量" desc="以环境变量注入 agent 容器，不会出现在对话里；改动在重启 agent 后生效。">
          <Button size="sm" onClick={() => setSecretOpen(true)}>
            添加
          </Button>
        </SettingRow>
        {agent.secrets.map((s) => (
          <SettingRow key={s} dense title={<span className="font-mono text-[13px] font-normal">{s}</span>}>
            <Button size="sm" variant="ghost" className="text-danger" loading={busy === `del-${s}`} onClick={() => act(`del-${s}`, () => api.del(`/api/agents/${agent.id}/secrets/${s}`), "已删除，重启后生效")}>
              删除
            </Button>
          </SettingRow>
        ))}
      </SettingGroup>
      <SettingGroup title="运行">
        <SettingRow title="重启容器" desc={`当前状态：${agent.container}。重启后下次发消息时自动启动。`}>
          <Button size="sm" loading={busy === "restart"} onClick={() => act("restart", () => api.post(`/api/agents/${agent.id}/restart`), "已重启，下次发消息时自动启动")}>
            <RotateCcw className="size-3.5" /> 重启
          </Button>
        </SettingRow>
        <SettingRow title="导出" desc="人设、记忆和技能打包成一个文件。">
          <Button
            size="sm"
            onClick={() => {
              window.location.href = `/api/agents/${agent.id}/export`;
            }}
          >
            <Download className="size-3.5" /> 导出
          </Button>
        </SettingRow>
        <SettingRow title="删除 agent" desc="对话记录会保留在数据库中，容器会被移除。">
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            loading={busy === "delete"}
            onClick={async () => {
              if (!(await confirmDialog({ title: `删除「${agent.name}」？`, body: "对话记录会保留在数据库中，容器会被移除。", ok: "删除", danger: true }))) return;
              void act("delete", () => api.del(`/api/agents/${agent.id}`), "已删除").then(() => nav("/"));
            }}
          >
            <Trash2 className="size-3.5" /> 删除
          </Button>
        </SettingRow>
      </SettingGroup>
      <Sheet open={secretOpen} onClose={() => setSecretOpen(false)} title="添加密钥">
        <div className="space-y-4">
          <Field label="变量名" hint="大写字母、数字、下划线，例如 GITHUB_TOKEN">
            <input className={cx(inputClass, "font-mono")} value={secretName} onChange={(e) => setSecretName(e.target.value.toUpperCase())} />
          </Field>
          <Field label="值">
            <input className={cx(inputClass, "font-mono")} type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} autoComplete="off" />
          </Field>
          <Button
            variant="primary"
            className="w-full"
            loading={busy === "secret"}
            onClick={() =>
              act("secret", () => api.put(`/api/agents/${agent.id}/secrets/${secretName}`, { value: secretValue }), "已保存，重启 agent 后生效").then(() => {
                setSecretOpen(false);
                setSecretName("");
                setSecretValue("");
              })
            }
          >
            保存
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
