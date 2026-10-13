import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar } from "../components/AgentBits";
import { Button, Card, Field, Header, Loading, Segmented, Toggle, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import type { Agent, Desktop, DesktopPolicy, Template } from "../lib/types";

interface Model {
  id: string;
  compat?: "ok" | "upstream_error";
}

export function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const models = useQuery({ queryKey: ["models"], queryFn: () => api.get<Model[]>("/api/models"), staleTime: 300_000 });
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {!models.data?.some((m) => m.id === value) && value && <option value={value}>{value}</option>}
      {models.data?.map((m) => (
        <option key={m.id} value={m.id}>
          {m.compat === "ok" ? "✓ " : ""}
          {m.id}
        </option>
      ))}
    </select>
  );
}

export default function AgentEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<Template[]>("/api/templates") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ defaultModel: string }>("/api/settings") });
  const desktops = useQuery({ queryKey: ["desktops"], queryFn: () => api.get<Desktop[]>("/api/desktops") });
  const existing = useQuery({ queryKey: ["agent", id], queryFn: () => api.get<Agent>(`/api/agents/${id}`), enabled: editing });

  const [template, setTemplate] = useState("assistant");
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [model, setModel] = useState("");
  const [persona, setPersona] = useState("");
  const [desktopPolicy, setDesktopPolicy] = useState<DesktopPolicy>({ mode: "on_demand" });
  const [approvalPolicy, setApprovalPolicy] = useState<"auto" | "ask">("auto");
  const [hostAccess, setHostAccess] = useState(false);
  const [effort, setEffort] = useState<string>("");
  const [budget, setBudget] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing && settings.data && !model) setModel(settings.data.defaultModel);
  }, [editing, settings.data, model]);

  useEffect(() => {
    const a = existing.data;
    if (!a) return;
    setTemplate(a.template);
    setName(a.name);
    setEmoji(a.emoji);
    setModel(a.model);
    setPersona(a.persona);
    setDesktopPolicy(a.desktop_policy);
    setApprovalPolicy(a.approval_policy);
    setHostAccess(a.host_access);
    setEffort(a.effort ?? "");
    setBudget(a.budget_daily_usd ? String(a.budget_daily_usd) : "");
  }, [existing.data]);

  const pick = (t: Template) => {
    setTemplate(t.id);
    setEmoji(t.emoji);
    setPersona(t.persona);
    setDesktopPolicy(t.desktopPolicy);
    setApprovalPolicy(t.approvalPolicy);
    setHostAccess(t.hostAccess);
    if (!name || templates.data?.some((x) => x.name === name)) setName(t.name);
  };

  useEffect(() => {
    if (!editing && templates.data && !name) pick(templates.data[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.data]);

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name,
        emoji,
        template,
        persona,
        model,
        effort: effort || null,
        approvalPolicy,
        desktopPolicy,
        hostAccess,
        budgetDailyUsd: budget ? Number(budget) : null,
      };
      const a = editing ? await api.patch<Agent>(`/api/agents/${id}`, body) : await api.post<Agent>("/api/agents", body);
      void qc.invalidateQueries();
      toast(editing ? "已保存" : "已创建");
      nav(editing ? `/agents/${a.id}` : `/agents/${a.id}/chat`, { replace: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setSaving(false);
    }
  };

  if (editing && existing.isLoading) return <Loading />;
  return (
    <div className="pb-28">
      <Header back title={editing ? "编辑 agent" : "新建 agent"} />
      <div className="px-4 space-y-5">
        {!editing && (
          <div className="grid grid-cols-2 gap-2.5">
            {templates.data?.map((t) => (
              <Card key={t.id} onClick={() => pick(t)} className={cx("p-3", template === t.id && "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]")}>
                <div className="text-2xl">{t.emoji}</div>
                <div className="font-medium mt-1">{t.name}</div>
                <div className="text-xs text-muted mt-0.5 line-clamp-2">{t.description}</div>
              </Card>
            ))}
          </div>
        )}
        <div className="flex items-end gap-3">
          <AgentAvatar emoji={emoji || "✨"} size="lg" />
          <Field label="名字">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </Field>
          <Field label="图标">
            <input className={cx(inputClass, "w-16 text-center")} value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} />
          </Field>
        </div>
        <Field label="模型" hint="✓ 表示已实测可用（经 new-api）">
          <ModelSelect value={model} onChange={setModel} />
        </Field>
        <Field group label="桌面">
          <Segmented
            value={desktopPolicy.mode}
            onChange={(m) => setDesktopPolicy(m === "fixed" ? { mode: "fixed", desktopId: desktops.data?.[0]?.id ?? "" } : { mode: m })}
            options={[
              { value: "none", label: "不用" },
              { value: "on_demand", label: "按需借用" },
              { value: "fixed", label: "固定一台" },
            ]}
          />
        </Field>
        {desktopPolicy.mode === "fixed" &&
          (desktops.data?.length ? (
            <select className={inputClass} value={desktopPolicy.desktopId} onChange={(e) => setDesktopPolicy({ mode: "fixed", desktopId: e.target.value })}>
              {desktops.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-sm text-warn">还没有桌面，请先到「桌面」页新建一台。</div>
          ))}
        <Field group label="命令审批">
          <Segmented
            value={approvalPolicy}
            onChange={setApprovalPolicy}
            options={[
              { value: "auto", label: "自动执行（容器内）" },
              { value: "ask", label: "每条都问我" },
            ]}
          />
        </Field>
        <Card className="p-4 flex items-start gap-3">
          <div className="flex-1">
            <div className="font-medium">允许操作宿主服务器</div>
            <div className="text-xs text-muted mt-1">开启后可用 host_exec 在这台服务器上执行命令。只读命令自动放行，其余每条都要你在手机上批准。</div>
          </div>
          <Toggle checked={hostAccess} onChange={setHostAccess} label="允许操作宿主服务器" />
        </Card>
        <button className="flex items-center gap-1 text-sm text-muted" onClick={() => setAdvanced(!advanced)}>
          高级设置 <ChevronDown className={cx("size-4 transition", advanced && "rotate-180")} />
        </button>
        {advanced && (
          <div className="space-y-5">
            <Field label="人设与工作方式" hint="会作为系统指令发给模型">
              <textarea className={cx(inputClass, "min-h-36")} value={persona} onChange={(e) => setPersona(e.target.value)} />
            </Field>
            <Field group label="推理强度">
              <Segmented
                value={(effort || "default") as string}
                onChange={(v) => setEffort(v === "default" ? "" : v)}
                options={[
                  { value: "default", label: "默认" },
                  { value: "low", label: "低" },
                  { value: "medium", label: "中" },
                  { value: "high", label: "高" },
                ]}
              />
            </Field>
            <Field label="每日预算（美元）" hint="需要在设置里配置 new-api 管理令牌，并为该 agent 生成专属令牌后才生效">
              <input className={inputClass} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="不限" />
            </Field>
          </div>
        )}
      </div>
      <div className="fixed bottom-0 inset-x-0 bg-surface border-t border-line p-3 safe-bottom">
        <div className="max-w-2xl mx-auto">
          <Button variant="primary" size="lg" className="w-full" onClick={save} loading={saving} disabled={!name.trim() || !model}>
            {editing ? "保存" : "创建并开始对话"}
          </Button>
        </div>
      </div>
    </div>
  );
}
