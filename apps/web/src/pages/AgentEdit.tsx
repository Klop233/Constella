import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar } from "../components/AgentBits";
import { Button, Card, Field, Header, Loading, Segmented, Select, Toggle, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { KIND_INFO } from "../lib/instances";
import { useModelLabel, useModels, type ModelEntry } from "../lib/models";
import { effortLabel, fitIndex, modelEfforts } from "../lib/effort";
import type { Agent, Desktop, DesktopPolicy, Template } from "../lib/types";

/** Position of an instance in an agent's bindings (unbound ones last). */
function rank(p: DesktopPolicy, id: string): number {
  const i = p.desktopIds.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Model picker for forms: options grouped by provider, a green dot on models whose test passed in settings. */
export function ModelSelect({ value, onChange, label: name }: { value: string; onChange: (v: string) => void; label?: string }) {
  const models = useModels();
  const label = useModelLabel();
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models.data ?? []) groups.set(m.providerName, [...(groups.get(m.providerName) ?? []), m]);
  const known = models.data?.some((m) => m.ref === value);
  const options = [
    ...(!known && value ? [{ value, label: label(value) }] : []),
    ...[...groups].flatMap(([provider, list]) =>
      list.map((m) => ({
        value: m.ref,
        group: provider,
        label: (
          <>
            {m.label}
            {m.test?.ok && <span title="测试通过" className="inline-block size-1.5 ml-1.5 align-middle rounded-full bg-[var(--ok)]" />}
          </>
        ),
      })),
    ),
  ];
  return <Select label={name} className="w-full" value={value} options={options} onChange={onChange} />;
}

export default function AgentEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<Template[]>("/api/templates") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ defaultModel: string; defaultEffort: string | null }>("/api/settings") });
  const desktops = useQuery({ queryKey: ["desktops"], queryFn: () => api.get<Desktop[]>("/api/desktops") });
  const existing = useQuery({ queryKey: ["agent", id], queryFn: () => api.get<Agent>(`/api/agents/${id}`), enabled: editing });
  const models = useModels();

  const [template, setTemplate] = useState("assistant");
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [model, setModel] = useState("");
  const [persona, setPersona] = useState("");
  const [desktopPolicy, setDesktopPolicy] = useState<DesktopPolicy>({ desktopIds: [] });
  const [hostAccess, setHostAccess] = useState(false);
  const [manageConstella, setManageConstella] = useState(false);
  const [effort, setEffort] = useState<string>("");
  const { efforts } = modelEfforts(models.data, model);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing && settings.data && !model) {
      setModel(settings.data.defaultModel);
      setEffort(settings.data.defaultEffort ?? "");
    }
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
    setHostAccess(a.host_access);
    setManageConstella(a.manage_constella);
    setEffort(a.effort ?? "");
  }, [existing.data]);

  const pick = (t: Template) => {
    setTemplate(t.id);
    setEmoji(t.emoji);
    setPersona(t.persona);
    // Instance bindings are the owner's pick, not part of a template.
    setHostAccess(t.hostAccess);
    setManageConstella(t.manageConstella);
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
        desktopPolicy,
        hostAccess,
        manageConstella,
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
      <div className="px-4 space-y-5 lg:max-w-3xl">
        {!editing && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
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
          <div className="flex-1 min-w-0">
            <Field label="名字">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </Field>
          </div>
          <div className="w-20 shrink-0">
            <Field label="图标">
              <input className={cx(inputClass, "text-center")} value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} />
            </Field>
          </div>
        </div>
        <Field
          label="模型"
          hint={
            models.data && !models.data.length ? (
              <>
                还没有可用的模型，先到
                <button type="button" className="text-accent hover:underline mx-0.5" onClick={() => nav("/settings?s=models")}>
                  设置 → 模型
                </button>
                添加服务商。
              </>
            ) : (
              "绿点表示在「设置 → 模型」里测试通过"
            )
          }
        >
          <ModelSelect value={model} onChange={setModel} />
        </Field>
        <Field group label="实例" hint="按选择的顺序优先使用；agent 需要时也可以自己新建">
          {desktops.data?.length ? (
            <div className="space-y-1.5">
              {[...desktops.data]
                .sort((a, b) => rank(desktopPolicy, a.id) - rank(desktopPolicy, b.id))
                .map((d) => {
                  const ids = desktopPolicy.desktopIds;
                  const idx = ids.indexOf(d.id);
                  const Icon = KIND_INFO[d.kind].icon;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDesktopPolicy({ desktopIds: idx >= 0 ? ids.filter((x) => x !== d.id) : [...ids, d.id] })}
                      className={cx(
                        "w-full flex items-center gap-2.5 rounded-lg border px-3 h-10 text-left text-[13.5px] transition",
                        idx >= 0 ? "border-[var(--color-accent)] bg-surface-2" : "border-line text-muted hover:text-[var(--text)]",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1 truncate">{d.name}</span>
                      <span className="text-xs text-muted">{KIND_INFO[d.kind].label}</span>
                      <span className={cx("size-5 rounded-full text-[11px] grid place-items-center", idx >= 0 ? "bg-accent text-white" : "border border-line")}>
                        {idx >= 0 ? idx + 1 : ""}
                      </span>
                    </button>
                  );
                })}
            </div>
          ) : (
            <div className="text-sm text-muted">还没有实例。可以到「实例」页新建，或让 agent 需要时自己新建。</div>
          )}
        </Field>
        <Card className="p-3 flex items-start gap-3">
          <div className="flex-1">
            <div className="font-medium">允许操作宿主服务器</div>
            <div className="text-xs text-muted mt-1">开启后可用 host_exec 在这台服务器上执行命令。只读命令直接执行，其余按「设置 → 权限」审批。</div>
          </div>
          <Toggle checked={hostAccess} onChange={setHostAccess} label="允许操作宿主服务器" />
        </Card>
        <Card className="p-3 flex items-start gap-3">
          <div className="flex-1">
            <div className="font-medium">允许管理 Constella</div>
            <div className="text-xs text-muted mt-1">开启后可查看和编排其他 agent，也可以创建、修改、归档和重启 agent；平台配置和生命周期变更都会先请主人确认。</div>
          </div>
          <Toggle checked={manageConstella} onChange={setManageConstella} label="允许管理 Constella" />
        </Card>
        <button className="flex items-center gap-1 text-sm text-muted" onClick={() => setAdvanced(!advanced)}>
          高级设置 <ChevronDown className={cx("size-4 transition", advanced && "rotate-180")} />
        </button>
        {advanced && (
          <div className="space-y-5">
            <Field label="人设与工作方式" hint="会作为系统指令发给模型">
              <textarea className={cx(inputClass, "min-h-36")} value={persona} onChange={(e) => setPersona(e.target.value)} />
            </Field>
            {efforts.length > 0 && (
              <Field group label="推理强度">
                <Segmented
                  value={effort ? efforts[fitIndex(efforts, effort)]! : "default"}
                  onChange={(v) => setEffort(v === "default" ? "" : v)}
                  options={[{ value: "default", label: "默认" }, ...efforts.map((e) => ({ value: e, label: effortLabel(e) }))]}
                />
              </Field>
            )}
          </div>
        )}
      </div>
      <div className="fixed bottom-0 inset-x-0 lg:left-64 bg-surface border-t border-line p-3 safe-bottom">
        <div className="max-w-2xl mx-auto">
          <Button variant="primary" size="lg" className="w-full" onClick={save} loading={saving} disabled={!name.trim() || !model}>
            {editing ? "保存" : "创建并开始对话"}
          </Button>
        </div>
      </div>
    </div>
  );
}
