import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, MessageSquarePlus, Pencil, RotateCcw, Share2, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar, AgentStatus } from "../components/AgentBits";
import { ArtifactRows } from "../components/ArtifactList";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Card, Empty, Field, Header, IconButton, Loading, Row, Section, Segmented, Sheet, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { STATUS_TEXT, statusTone, timeAgo } from "../lib/format";
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
    <div>
      <Header
        back="/"
        title={a.name}
        right={
          <IconButton label="编辑" onClick={() => nav(`/agents/${a.id}/edit`)}>
            <Pencil className="size-4" />
          </IconButton>
        }
      />
      <div className="px-4 space-y-4 lg:max-w-3xl">
        <div className="flex items-center gap-3">
          <AgentAvatar emoji={a.emoji} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold truncate">{a.name}</div>
            <AgentStatus agent={a} />
            <div className="text-xs text-muted mt-1 truncate">
              {modelLabel(a.model)} · {a.desktop_policy.desktopIds.length ? `实例 ${a.desktop_policy.desktopIds.length} 个` : "没有实例"}
              {a.host_access && " · 可操作宿主机"}
            </div>
          </div>
        </div>
        <Button variant="primary" className="w-full" onClick={() => nav(`/agents/${a.id}/chat`)}>
          <MessageSquarePlus className="size-4" /> 新对话
        </Button>
        <Segmented
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
  const q = useQuery({ queryKey: ["conversations", agentId], queryFn: () => api.get<Conversation[]>(`/api/agents/${agentId}/conversations`) });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <Empty title="还没有对话" />;
  return (
    <Card className="divide-y divide-[var(--border)] overflow-hidden mb-6">
      {q.data.map((c) => (
        <Row
          key={c.id}
          title={c.title}
          sub={`${timeAgo(c.updated_at)}${c.source === "schedule" ? " · 定时任务" : ""}`}
          right={c.last_status && c.last_status !== "done" ? <Badge tone={statusTone(c.last_status)}>{STATUS_TEXT[c.last_status]}</Badge> : undefined}
          onClick={() => nav(`/c/${c.id}`)}
        />
      ))}
    </Card>
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
    <div className="space-y-5 pb-6">
      {(["agent", "user"] as const).map((scope) => (
        <Section
          key={scope}
          title={scope === "agent" ? "它的记忆" : "关于你（所有 agent 共享）"}
          action={
            <button
              className="text-xs text-muted hover:text-[var(--text)]"
              onClick={() => {
                setDraft(q.data.memory[scope]);
                setEditing(scope);
              }}
            >
              编辑
            </button>
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
          <button
            className="text-xs text-muted hover:text-[var(--text)] flex items-center gap-1"
            disabled={curating}
            onClick={async () => {
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
            <Sparkles className={cx("size-4", curating && "animate-pulse")} /> 整理
          </button>
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
                  if (!confirm(`删除技能 ${skill.skill.name}？`)) return;
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
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ newapiAdminConfigured: boolean }>("/api/settings") });
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
    <div className="space-y-5 pb-8">
      <Section title="密钥（以环境变量注入，不会出现在对话里）" action={<button className="text-xs text-muted hover:text-[var(--text)]" onClick={() => setSecretOpen(true)}>添加</button>}>
        <Card className="divide-y divide-[var(--border)] overflow-hidden">
          {agent.secrets.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted">无</div>
          ) : (
            agent.secrets.map((s) => (
              <Row
                key={s}
                icon={<KeyRound className="size-4 text-muted" />}
                title={<span className="font-mono text-sm">{s}</span>}
                right={
                  <button className="text-danger text-sm" onClick={() => act(`del-${s}`, () => api.del(`/api/agents/${agent.id}/secrets/${s}`), "已删除，重启后生效")}>
                    删除
                  </button>
                }
              />
            ))
          )}
        </Card>
      </Section>
      <Section title="new-api">
        <Card className="p-3 space-y-2.5">
          <div className="text-sm text-muted">
            {agent.newapi_token_id ? `使用专属令牌 #${agent.newapi_token_id}，可按 agent 统计费用和限额。` : "使用全局令牌。生成专属令牌后可单独统计费用、设置每日预算。"}
          </div>
          <Button
            className="w-full"
            disabled={!settings.data?.newapiAdminConfigured}
            loading={busy === "token"}
            onClick={() => act("token", () => api.post(`/api/agents/${agent.id}/newapi-token`, {}), "已生成专属令牌")}
          >
            {agent.newapi_token_id ? "重新生成专属令牌" : "生成专属令牌"}
          </Button>
          {!settings.data?.newapiAdminConfigured && <div className="text-xs text-muted">需要先在「设置 → new-api」填写管理令牌</div>}
        </Card>
      </Section>
      <Section title="运行">
        <Card className="divide-y divide-[var(--border)] overflow-hidden">
          <Row
            icon={<RotateCcw className="size-4 text-muted" />}
            title="重启 agent 容器"
            sub={`当前：${agent.container}`}
            onClick={() => act("restart", () => api.post(`/api/agents/${agent.id}/restart`), "已重启，下次发消息时自动启动")}
          />
          <Row
            icon={<Download className="size-4 text-muted" />}
            title="导出（人设、记忆、技能）"
            onClick={() => {
              window.location.href = `/api/agents/${agent.id}/export`;
            }}
          />
          <Row
            icon={<Trash2 className="size-4 text-danger" />}
            title={<span className="text-danger">删除 agent</span>}
            onClick={() => {
              if (!confirm(`删除「${agent.name}」？对话记录会保留在数据库中，容器会被移除。`)) return;
              void act("delete", () => api.del(`/api/agents/${agent.id}`), "已删除").then(() => nav("/"));
            }}
          />
        </Card>
      </Section>
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
