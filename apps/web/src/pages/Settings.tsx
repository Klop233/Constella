import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Boxes, Brain, ChevronRight, ClipboardCheck, Gauge, LogOut, Palette, Search, Server, Settings2, Shield, Sparkles, type LucideIcon } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ModelSelect } from "./AgentEdit";
import { Badge, Button, Field, Header, Loading, navItemClass, Segmented, SettingGroup, SettingRow, Sheet, StatTile, Tabs, Toggle, cx, inputClass, selectClass, toast } from "../components/ui";
import { api, logout } from "../lib/api";
import { setAppearance, useAppearance, type Appearance } from "../lib/appearance";
import { fmtMinutes, RUN_TIMEOUTS, runTimeoutLabel, timeAgo, tokens } from "../lib/format";
import { useModels, useProviders, type ModelEntry, type Provider } from "../lib/models";
import { currentSubscription, disablePush, enablePush, pushSupported } from "../lib/push";
import type { Agent, Effort, Schedule } from "../lib/types";

type NotifyKind = "done" | "failed" | "approval" | "stuck";

interface SettingsView {
  defaultModel: string;
  reflectModel: string;
  defaultEffort: Effort | null;
  autoResume: boolean;
  maxAutoResumes: number;
  runTimeoutMinutes: number;
  runWatchdogMinutes: number;
  browserHtml: boolean;
  approvalMode: "ask" | "smart" | "auto";
  agentIdleMinutes: number;
  desktopIdleMinutes: number;
  autoReflect: boolean;
  reflectMinToolCalls: number;
  notifyOn: Record<NotifyKind, boolean>;
  quietHours: { enabled: boolean; start: string; end: string };
  backupKeep: number;
  modelNameFormat: "paren" | "dash";
  newapiBaseUrl: string;
  newapiAdminConfigured: boolean;
  newapiAdminUserId: string;
  telegramConfigured: boolean;
  telegramChatId: string;
  timezone: string;
  origins: string[];
  dataDir: string;
}

interface Me {
  name: string;
  totp: boolean;
  passkeys: { id: string; name: string; rp_id: string; created_at: string; last_used_at: string | null }[];
  sessions: { id: string; device: string; ip: string; last_seen_at: string; current: boolean }[];
}

type Save = (patch: Record<string, unknown>, ok?: string) => Promise<void>;

const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "通用", icon: Settings2 },
  { id: "models", label: "模型", icon: Boxes },
  { id: "learning", label: "学习", icon: Brain },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "notify", label: "通知", icon: Bell },
  { id: "security", label: "安全", icon: Shield },
  { id: "system", label: "系统", icon: Server },
];
/** Old links (?s=newapi) land on the section that replaced them. */
const ALIASES: Record<string, string> = { newapi: "models" };

/** Compact select for a fixed set of values; a value set elsewhere (env) still shows up. */
function Choice<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: typeof value === "number" ? fmtMinutes(value) : String(value) }, ...options];
  return (
    <select
      aria-label={label}
      className={selectClass}
      value={String(value)}
      onChange={(e) => {
        const o = all.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {all.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const minuteOptions = (list: number[], zero?: string) => list.map((m) => ({ value: m, label: m === 0 ? zero! : fmtMinutes(m) }));

export default function Settings() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsView>("/api/settings") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
  const save: Save = async (patch, ok = "已保存") => {
    try {
      await api.patch("/api/settings", patch);
      toast(ok);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  if (!settings.data || !me.data) return <Loading />;
  const s = settings.data;
  const picked = params.get("s");
  // Desktop always shows a section (general by default); phones show the index until one is picked.
  const current = SECTIONS.find((x) => x.id === (picked && (ALIASES[picked] ?? picked))) ?? SECTIONS[0]!;
  const go = (id: string) => setParams({ s: id }, { replace: !!picked });

  const body = (
    <div className="space-y-5">
      {current.id === "general" && <GeneralSection s={s} save={save} />}
      {current.id === "models" && <ModelsSection s={s} save={save} />}
      {current.id === "learning" && <LearningSection s={s} save={save} />}
      {current.id === "appearance" && <AppearanceSection />}
      {current.id === "notify" && <NotifySection s={s} save={save} />}
      {current.id === "security" && <SecuritySection me={me.data} />}
      {current.id === "system" && <SystemSection s={s} save={save} />}
    </div>
  );

  return (
    <div>
      {/* Phone: section index, then the picked section with a back button. */}
      <div className="lg:hidden">
        {picked ? (
          <>
            <Header title={current.label} back="/settings" />
            <div className="px-4 pb-8">{body}</div>
          </>
        ) : (
          <>
            <Header title="设置" sub={me.data.name} />
            <div className="px-2 pb-6 space-y-2">
              <nav className="space-y-px">
                {SECTIONS.map((x) => (
                  <button key={x.id} onClick={() => go(x.id)} className="w-full flex items-center gap-3 h-9 px-2.5 rounded-md text-left hover:bg-surface-2 active:bg-surface-2">
                    <x.icon className="size-4 text-muted" strokeWidth={1.8} />
                    <span className="flex-1">{x.label}</span>
                    <ChevronRight className="size-4 text-muted" />
                  </button>
                ))}
              </nav>
              <div className="h-px bg-[var(--border)] mx-2.5" />
              <nav className="space-y-px">
                <button onClick={() => nav("/audit")} className="w-full flex items-center gap-3 h-9 px-2.5 rounded-md text-left hover:bg-surface-2">
                  <ClipboardCheck className="size-4 text-muted" strokeWidth={1.8} />
                  <span className="flex-1">审计</span>
                  <ChevronRight className="size-4 text-muted" />
                </button>
                <button onClick={() => nav("/usage")} className="w-full flex items-center gap-3 h-9 px-2.5 rounded-md text-left hover:bg-surface-2">
                  <Gauge className="size-4 text-muted" strokeWidth={1.8} />
                  <span className="flex-1">用量统计</span>
                  <ChevronRight className="size-4 text-muted" />
                </button>
                <button onClick={() => nav("/reflect")} className="w-full flex items-center gap-3 h-9 px-2.5 rounded-md text-left hover:bg-surface-2">
                  <Sparkles className="size-4 text-muted" strokeWidth={1.8} />
                  <span className="flex-1">回顾</span>
                  <ChevronRight className="size-4 text-muted" />
                </button>
                <button onClick={() => logout(qc)} className="w-full flex items-center gap-3 h-9 px-2.5 rounded-md text-left text-danger hover:bg-surface-2">
                  <LogOut className="size-4" strokeWidth={1.8} />
                  退出登录
                </button>
              </nav>
            </div>
          </>
        )}
      </div>

      {/* Desktop: Claude Code-style two-pane settings. */}
      <div className="hidden lg:flex gap-6 pt-4 pb-8">
        <nav className="w-40 shrink-0 space-y-px sticky top-4 self-start">
          <div className="px-2.5 pb-1 text-xs text-muted">设置</div>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              onClick={() => go(x.id)}
              className={cx(navItemClass(x.id === current.id), "w-full h-7 text-left text-[13px]")}
            >
              <x.icon className="size-4" strokeWidth={1.8} />
              {x.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 max-w-2xl">{body}</div>
      </div>
    </div>
  );
}

function GeneralSection({ s, save }: { s: SettingsView; save: Save }) {
  return (
    <>
      <SettingGroup title="任务">
        <SettingRow
          title="中断后自动继续"
          desc={`任务被重启、Codex 崩溃、网络或限流等临时故障打断${s.runTimeoutMinutes ? `，或单轮跑满 ${runTimeoutLabel(s.runTimeoutMinutes)}` : ""}时，等一会儿自动在原对话里接着做；hub 重启也不会丢。每一轮有进展就一直接着做，连续 ${s.maxAutoResumes} 轮都没有进展才停下，并生成诊断报告。`}
        >
          <Toggle checked={s.autoResume} onChange={(v) => void save({ autoResume: v }, v ? "已开启自动继续" : "已关闭自动继续")} label="中断后自动继续" />
        </SettingRow>
        {s.autoResume && (
          <SettingRow title="连续无进展上限" desc="连续这么多轮自动继续都没有进展（没有一个工具调用成功）就停下，生成诊断报告等你选方案。">
            <Choice
              label="连续无进展上限"
              value={s.maxAutoResumes}
              options={[1, 2, 3, 5, 10].map((n) => ({ value: n, label: `${n} 次` }))}
              onChange={(v) => void save({ maxAutoResumes: v })}
            />
          </SettingRow>
        )}
        <SettingRow
          title="单轮最长运行"
          desc={
            s.runTimeoutMinutes === 0
              ? "不限制单轮时长，跑多久都不会被打断；上下文可能一直变长。可以在对话里单独调整某个对话。"
              : s.autoResume
                ? "一轮跑满这么久就先停下，再开新的一轮接着做，避免单轮上下文无限变长。可以在对话里单独调整某个对话。"
                : "一轮跑满这么久就停止（开启自动继续后会接着做）。可以在对话里单独调整某个对话。"
          }
        >
          <Choice label="单轮最长运行" value={s.runTimeoutMinutes} options={minuteOptions(RUN_TIMEOUTS, "不限制")} onChange={(v) => void save({ runTimeoutMinutes: v })} />
        </SettingRow>
        <SettingRow title="卡住处理" desc="任务这么久没有任何动静（没有输出、没有工具调用、引擎也没在思考）时，监督员介入：判断后继续等、结束卡住的命令、提醒 agent、重启这一轮或重建容器；处理不了才请你决定。">
          <Choice label="卡住处理" value={s.runWatchdogMinutes} options={minuteOptions([5, 10, 20, 30, 60, 0], "不处理")} onChange={(v) => void save({ runWatchdogMinutes: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="浏览器">
        <SettingRow title="直接读取网页 HTML" desc="agent 用浏览器查信息时优先直接读页面 HTML，比看截图更快更准；要看布局、图片或验证码时照样截图。对新对话生效。">
          <Toggle checked={s.browserHtml} onChange={(v) => void save({ browserHtml: v }, v ? "已开启读取网页 HTML" : "已关闭读取网页 HTML")} label="直接读取网页 HTML" />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="审批">
        <SettingRow wide title="审批方式" desc={APPROVAL_DESC[s.approvalMode]}>
          <div className="w-64">
            <Segmented
              value={s.approvalMode}
              options={[
                { value: "ask", label: "每次询问" },
                { value: "smart", label: "智能" },
                { value: "auto", label: "全部自动" },
              ]}
              onChange={(v) => {
                if (v === "auto" && !confirm("全部自动后，删除数据、在宿主机上执行命令这类破坏性操作也不再需要你批准。确定吗？")) return;
                void save({ approvalMode: v }, "已保存审批方式");
              }}
            />
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

const APPROVAL_DESC: Record<SettingsView["approvalMode"], string> = {
  ask: "agent 每次请求审批都要你批准。",
  smart: "普通操作自动批准，agent 自己推进；只有破坏性操作（大范围删除、格式化磁盘、关机重启、清理 Docker、强制推送、删数据库表、改系统关键配置等）才问你。",
  auto: "所有审批都自动通过，包括破坏性操作。只在完全信任 agent 时使用。",
};

const EFFORTS: { value: Effort | "default"; label: string }[] = [
  { value: "default", label: "默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

function ModelsSection({ s, save }: { s: SettingsView; save: Save }) {
  const qc = useQueryClient();
  const providers = useProviders();
  const models = useModels();
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [admin, setAdmin] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("");
  const [all, setAll] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["models"] });
    void qc.invalidateQueries({ queryKey: ["providers"] });
  };
  const fail = (err: unknown) => toast(err instanceof Error ? err.message : String(err), "danger");

  const checkProvider = async (p: Provider) => {
    setChecks((c) => ({ ...c, [p.id]: "busy" }));
    type Check = { ok: boolean; models?: number; error?: string; ms: number };
    const r = await api.post<Check>(`/api/providers/${p.id}/test`).catch((e): Check => ({ ok: false, error: String(e.message ?? e), ms: 0 }));
    setChecks((c) => ({ ...c, [p.id]: { ok: r.ok, text: r.ok ? `正常 · ${r.models} 个模型 · ${(r.ms / 1000).toFixed(1)}s` : (r.error ?? "异常") } }));
    toast(r.ok ? `${p.name} 连接正常` : `${p.name}：${r.error}`, r.ok ? "ok" : "danger");
  };
  const removeProvider = async (p: Provider) => {
    if (!confirm(`删除 provider「${p.name}」？它下面的 ${p.models} 个模型会一起移除。`)) return;
    try {
      await api.del(`/api/providers/${p.id}`);
      toast("已删除");
      refresh();
    } catch (err) {
      fail(err);
    }
  };
  const testModels = async (refs: string[]) => {
    setTesting((t) => new Set([...t, ...refs]));
    let ok = 0;
    // A few at a time: providers rate-limit bursts.
    const queue = [...refs];
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let ref = queue.shift(); ref; ref = queue.shift()) {
          const r = await api.post<{ ok: boolean; error: string | null }>("/api/models/test", { ref }).catch((e) => ({ ok: false, error: String(e.message ?? e) }));
          if (r.ok) ok++;
          if (refs.length === 1) toast(r.ok ? "测试通过" : `测试失败：${r.error}`, r.ok ? "ok" : "danger");
          setTesting((t) => new Set([...t].filter((x) => x !== ref)));
          void qc.invalidateQueries({ queryKey: ["models"] });
        }
      }),
    );
    if (refs.length > 1) toast(`测试完成：${ok} / ${refs.length} 个可用`, ok === refs.length ? "ok" : "danger");
  };
  const setBare = async (m: ModelEntry, bare: boolean) => {
    await api.patch("/api/models", { ref: m.ref, bare }).catch(fail);
    void qc.invalidateQueries({ queryKey: ["models"] });
  };
  const removeModel = async (m: ModelEntry) => {
    await api.del(`/api/models?${new URLSearchParams({ ref: m.ref })}`).catch(fail);
    refresh();
  };

  const list = (models.data ?? []).filter((m) => (!only || m.provider === only) && `${m.label} ${m.model}`.toLowerCase().includes(q.toLowerCase()));
  const shown = all || q ? list : list.slice(0, 12);
  const dupes = new Set((models.data ?? []).map((m) => m.model).filter((name, i, a) => a.indexOf(name) !== i));

  return (
    <>
      <SettingGroup title="默认">
        <SettingRow wide title="新 agent 默认模型" desc="新建 agent 时预选的模型，之后每个 agent、每个对话都能单独改。">
          <div className="w-60">
            <ModelSelect value={s.defaultModel} onChange={(v) => void save({ defaultModel: v })} />
          </div>
        </SettingRow>
        <SettingRow wide title="新 agent 推理强度" desc="新建 agent 时预选；「默认」交给模型自己决定。">
          <div className="w-60">
            <Segmented value={s.defaultEffort ?? "default"} options={EFFORTS} onChange={(v) => void save({ defaultEffort: v === "default" ? null : v })} />
          </div>
        </SettingRow>
        <SettingRow wide title="复盘 / 诊断 / 监督用的模型" desc="总结经验、整理记忆、生成回顾，以及诊断出错的任务、监督卡住的任务都用它。建议选稳定、判断力好的模型。">
          <div className="w-60">
            <ModelSelect value={s.reflectModel} onChange={(v) => void save({ reflectModel: v })} />
          </div>
        </SettingRow>
        <SettingRow wide title="显示名格式" desc="每个模型都绑定一个 provider。同名的模型可以挑一个不带 provider，在下面的模型列表里设置。">
          <div className="w-60">
            <Segmented
              value={s.modelNameFormat}
              options={[
                { value: "paren", label: "model (provider)" },
                { value: "dash", label: "model - provider" },
              ]}
              onChange={(v) => void save({ modelNameFormat: v }).then(() => qc.invalidateQueries({ queryKey: ["models"] }))}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Provider">
        {providers.data?.map((p) => {
          const c = checks[p.id];
          return (
            <SettingRow
              wide
              dense
              key={p.id}
              title={
                <span className="flex items-center gap-1.5">
                  {p.name}
                  {p.builtin && <Badge>内置</Badge>}
                  {c && c !== "busy" && <Badge tone={c.ok ? "ok" : "danger"}>{c.ok ? "正常" : "异常"}</Badge>}
                </span>
              }
              desc={
                <>
                  <span className="font-mono break-all">{p.baseUrl}</span> · {p.models} 个模型 · {p.keyHint ? `Key ${p.keyHint}` : "未设置 Key"}
                  {p.builtin && ` · 管理令牌${s.newapiAdminConfigured ? "已配置" : "未配置"}`}
                  {c && c !== "busy" && <span className={cx("block", c.ok ? "text-ok" : "text-danger")}>{c.text}</span>}
                </>
              }
            >
              <Button size="sm" variant="soft" loading={c === "busy"} onClick={() => void checkProvider(p)}>
                测试
              </Button>
              {p.builtin ? (
                <Button size="sm" variant="soft" onClick={() => setAdmin(true)}>
                  管理令牌
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="soft" onClick={() => setEditing(p)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void removeProvider(p)}>
                    删除
                  </Button>
                </>
              )}
            </SettingRow>
          );
        })}
        <SettingRow wide title="添加 provider" desc="任何支持 OpenAI Responses API 的地址：另一个 new-api、CLIProxyAPI、OpenRouter 等。Codex 只走 Responses 接口，只支持 Chat Completions 的服务用不了。">
          <Button size="sm" variant="soft" onClick={() => setEditing("new")}>
            添加
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={`模型 · ${models.data?.length ?? 0}`}>
        <div className="py-2 flex flex-wrap items-center gap-2">
          <label className="flex-1 min-w-40 flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface">
            <Search className="size-4 text-muted shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型" className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" />
          </label>
          {(providers.data?.length ?? 0) > 1 && (
            <select aria-label="按 provider 筛选" className={selectClass} value={only} onChange={(e) => setOnly(e.target.value)}>
              <option value="">全部 provider</option>
              {providers.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="soft" disabled={!list.length || testing.size > 0} onClick={() => void testModels(list.map((m) => m.ref))}>
            {testing.size > 1 ? `测试中 · 剩 ${testing.size}` : "全部测试"}
          </Button>
          <Button size="sm" variant="soft" onClick={() => setAdding(only || providers.data?.[0]?.id || "newapi")}>
            添加模型
          </Button>
        </div>
        {models.isLoading && <Loading />}
        {models.data && !models.data.length && <div className="py-4 text-center text-[13px] text-muted">还没有模型，点「添加模型」从 provider 里挑选</div>}
        {shown.map((m) => (
          <SettingRow
            wide
            dense
            key={m.ref}
            title={<span className="font-mono text-[13px] break-all">{m.label}</span>}
            desc={
              <>
                {/* The label already names the provider unless it was dropped. */}
                {m.bare && `${m.providerName} · `}
                {!m.test ? (
                  "未测试"
                ) : m.test.ok ? (
                  <span className="text-ok">✓ 可用{m.test.ms != null && ` · ${(m.test.ms / 1000).toFixed(1)}s`}</span>
                ) : (
                  <span className="text-danger" title={m.test.error ?? ""}>
                    ✗ {(m.test.error ?? "失败").slice(0, 80)}
                  </span>
                )}
                {m.test && ` · ${timeAgo(m.test.at)}测试`}
              </>
            }
          >
            <label className={cx("flex items-center gap-1.5 text-xs", dupes.has(m.model) ? "text-[var(--text)]" : "text-muted")} title="显示名只写模型名，不带 provider；同名模型里只能选一个">
              省略 provider
              <Toggle checked={m.bare} onChange={(v) => void setBare(m, v)} label={`${m.label} 显示名省略 provider`} />
            </label>
            <Button size="sm" variant="soft" loading={testing.has(m.ref)} onClick={() => void testModels([m.ref])}>
              测试
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => void removeModel(m)}>
              移除
            </Button>
          </SettingRow>
        ))}
        {!all && !q && list.length > shown.length && (
          <button type="button" onClick={() => setAll(true)} className="w-full py-2 text-[13px] text-muted hover:text-[var(--text)] text-left">
            显示全部 {list.length} 个
          </button>
        )}
      </SettingGroup>

      <UsagePanel />

      <ProviderSheet provider={editing} onClose={() => setEditing(null)} onSaved={(p, created) => {
        refresh();
        setEditing(null);
        if (created) setAdding(p.id);
      }} />
      <AddModelsSheet provider={adding} providers={providers.data ?? []} models={models.data ?? []} onClose={() => setAdding(null)} onAdded={refresh} />
      <AdminTokenSheet open={admin} onClose={() => setAdmin(false)} s={s} save={save} />
    </>
  );
}

function ProviderSheet({ provider, onClose, onSaved }: { provider: Provider | "new" | null; onClose: () => void; onSaved: (p: Provider, created: boolean) => void }) {
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const isNew = provider === "new";
  useEffect(() => {
    if (provider) setForm(provider === "new" ? { name: "", baseUrl: "", apiKey: "" } : { name: provider.name, baseUrl: provider.baseUrl, apiKey: "" });
  }, [provider]);
  const submit = async () => {
    setBusy(true);
    try {
      const body = isNew ? form : { name: form.name, baseUrl: form.baseUrl, ...(form.apiKey ? { apiKey: form.apiKey } : {}) };
      const p = isNew ? await api.post<Provider>("/api/providers", body) : await api.patch<Provider>(`/api/providers/${(provider as Provider).id}`, body);
      toast(isNew ? "已添加，接着挑选要用的模型" : "已保存");
      onSaved(p, isNew);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={!!provider} onClose={onClose} title={isNew ? "添加 provider" : "编辑 provider"}>
      <div className="space-y-3">
        <Field label="名称" hint="会出现在模型显示名里，比如 gpt-5 (CLIProxy)">
          <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={40} placeholder="CLIProxy" />
        </Field>
        <Field label="地址" hint="OpenAI 兼容的 API 地址，一般以 /v1 结尾；agent 容器里的 localhost 不是宿主机，宿主机用 host.docker.internal">
          <input className={cx(inputClass, "font-mono")} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://host.docker.internal:8317/v1" autoComplete="off" />
        </Field>
        <Field label="API Key" hint={isNew ? "没有可以留空" : `留空不修改${(provider as Provider | null)?.keyHint ? `（当前 ${(provider as Provider).keyHint}）` : ""}`}>
          <input className={cx(inputClass, "font-mono")} type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" />
        </Field>
        <div className="text-xs text-muted">保存后对之后开始的任务生效，正在进行的任务不受影响。</div>
        <Button variant="primary" className="w-full" loading={busy} disabled={!form.name.trim() || !form.baseUrl.trim()} onClick={() => void submit()}>
          {isNew ? "添加" : "保存"}
        </Button>
      </div>
    </Sheet>
  );
}

function AddModelsSheet({ provider, providers, models, onClose, onAdded }: { provider: string | null; providers: Provider[]; models: ModelEntry[]; onClose: () => void; onAdded: () => void }) {
  const [pid, setPid] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (provider) {
      setPid(provider);
      setPicked(new Set());
      setManual("");
      setQ("");
    }
  }, [provider]);
  const remote = useQuery({ queryKey: ["provider-models", pid], queryFn: () => api.get<string[]>(`/api/providers/${pid}/models`), enabled: !!provider && !!pid, retry: false });
  const have = new Set(models.filter((m) => m.provider === pid).map((m) => m.model));
  const candidates = (remote.data ?? []).filter((id) => id.toLowerCase().includes(q.toLowerCase()));
  const fresh = candidates.filter((id) => !have.has(id));
  const typed = manual.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
  const count = new Set([...picked, ...typed.filter((x) => !have.has(x))]).size;
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ added: number }>("/api/models", { provider: pid, models: [...picked, ...typed] });
      toast(`已添加 ${r.added} 个模型`);
      onAdded();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={!!provider} onClose={onClose} title="添加模型">
      <div className="space-y-3">
        <Field label="Provider">
          <select
            className={inputClass}
            value={pid}
            onChange={(e) => {
              setPid(e.target.value);
              setPicked(new Set());
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-[13px] font-medium">它提供的模型</div>
            {fresh.length > 0 && (
              <button type="button" className="text-xs text-muted hover:text-[var(--text)]" onClick={() => setPicked(picked.size === fresh.length ? new Set() : new Set(fresh))}>
                {picked.size === fresh.length ? "全不选" : "全选"}
              </button>
            )}
          </div>
          {(remote.data?.length ?? 0) > 8 && (
            <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface">
              <Search className="size-4 text-muted shrink-0" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" />
            </label>
          )}
          <div className="max-h-64 overflow-y-auto rounded-lg border border-line divide-y divide-[var(--border)]">
            {remote.isLoading && <div className="px-3 py-2.5 text-[13px] text-muted">正在读取模型列表…</div>}
            {remote.error && <div className="px-3 py-2.5 text-[13px] text-danger">{(remote.error as Error).message}</div>}
            {remote.data && !candidates.length && <div className="px-3 py-2.5 text-[13px] text-muted">没有找到模型，可以在下面手动填写</div>}
            {candidates.map((id) => (
              <label key={id} className={cx("flex items-center gap-2.5 px-3 h-9 text-[13px]", have.has(id) ? "text-muted" : "hover:bg-surface-2 cursor-pointer")}>
                <input type="checkbox" className="accent-[var(--color-accent)]" checked={have.has(id) || picked.has(id)} disabled={have.has(id)} onChange={() => toggle(id)} />
                <span className="flex-1 font-mono truncate">{id}</span>
                {have.has(id) && <span className="text-xs">已添加</span>}
              </label>
            ))}
          </div>
        </div>
        <Field label="手动填写" hint="列表里没有的模型名，多个用空格或逗号隔开">
          <input className={cx(inputClass, "font-mono")} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="gpt-5-codex" />
        </Field>
        <Button variant="primary" className="w-full" loading={busy} disabled={!count} onClick={() => void submit()}>
          {count ? `添加 ${count} 个模型` : "添加"}
        </Button>
      </div>
    </Sheet>
  );
}

function AdminTokenSheet({ open, onClose, s, save }: { open: boolean; onClose: () => void; s: SettingsView; save: Save }) {
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState(s.newapiAdminUserId);
  return (
    <Sheet open={open} onClose={onClose} title="new-api 管理令牌">
      <div className="space-y-3">
        <div className="text-[13px] text-muted">用于为每个 agent 在内置 new-api 里生成专属令牌，分开统计费用、设每日预算。</div>
        <Field label="系统访问令牌" hint="new-api 后台 → 个人设置 → 生成系统访问令牌。留空保存可清除">
          <input className={cx(inputClass, "font-mono")} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="用户 ID" hint="令牌所属账号的 ID（通常管理员是 1）">
          <input className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value)} inputMode="numeric" />
        </Field>
        <Button
          variant="primary"
          className="w-full"
          onClick={() =>
            void save({ newapiAdminToken: token, newapiAdminUserId: userId }).then(() => {
              onClose();
              setToken("");
            })
          }
        >
          保存
        </Button>
      </div>
    </Sheet>
  );
}

interface UsageStats {
  totals: { requests: number; runs: number; input: number; cached: number; output: number; hitRate: number | null };
  models: { model: string; label: string; providerName: string; requests: number; input: number; output: number; successRate: number | null; tps: number | null }[];
  providers: { provider: string; name: string; requests: number; input: number; cached: number; output: number; models: number }[];
  agents: { agentId: string; name: string; emoji: string; requests: number; input: number; output: number; spendUsd: number | null }[];
  spendUsd: number | null;
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

/** Usage at a glance, per model / provider / agent; the full breakdown lives on the 用量 page. */
function UsagePanel() {
  const [range, setRange] = useState<"today" | "7d" | "30d">("7d");
  const [tab, setTab] = useState<"models" | "providers" | "agents">("models");
  const q = useQuery({ queryKey: ["usage-stats", range, "", "", ""], queryFn: () => api.get<UsageStats>(`/api/usage/stats?range=${range}`) });
  const d = q.data;
  const th = "py-1.5 px-2 text-xs font-medium text-muted whitespace-nowrap";
  const td = "py-1.5 px-2 whitespace-nowrap tabular-nums";
  return (
    <SettingGroup title="用量">
      <div className="py-2 space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-56">
            <Segmented
              value={range}
              onChange={setRange}
              options={[
                { value: "today", label: "今天" },
                { value: "7d", label: "近 7 天" },
                { value: "30d", label: "近 30 天" },
              ]}
            />
          </div>
          <Link to="/usage" className="ml-auto text-xs text-muted hover:text-[var(--text)]">
            完整统计 ›
          </Link>
        </div>
        {!d ? (
          <Loading />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatTile size="sm" label={d.spendUsd != null ? "费用" : "任务"} value={d.spendUsd != null ? `$${d.spendUsd.toFixed(2)}` : d.totals.runs} />
              <StatTile size="sm" label="请求" value={d.totals.requests.toLocaleString()} />
              <StatTile size="sm" label="Tokens" value={tokens(d.totals.input + d.totals.output)} />
              <StatTile size="sm" label="缓存命中率" value={pct(d.totals.hitRate)} />
            </div>
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: "models", label: "模型" },
                { value: "providers", label: "Provider" },
                { value: "agents", label: "agent" },
              ]}
            />
            {d.totals.requests === 0 ? (
              <div className="py-3 text-center text-[13px] text-muted">这段时间没有请求</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  {tab === "models" && (
                    <>
                      <thead>
                        <tr className="border-b border-line">
                          <th className={cx(th, "text-left")}>模型</th>
                          <th className={cx(th, "text-right")}>请求</th>
                          <th className={cx(th, "text-right")}>Tokens</th>
                          <th className={cx(th, "text-right")}>成功率</th>
                          <th className={cx(th, "text-right")}>速度</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.models.map((m) => (
                          <tr key={m.model} className="border-b border-line last:border-0">
                            <td className={cx(td, "font-mono text-[12.5px] max-w-56 truncate")}>{m.label}</td>
                            <td className={cx(td, "text-right")}>{m.requests}</td>
                            <td className={cx(td, "text-right")}>{tokens(m.input + m.output)}</td>
                            <td className={cx(td, "text-right")}>{pct(m.successRate)}</td>
                            <td className={cx(td, "text-right")}>{m.tps != null ? <>{m.tps.toFixed(0)}<span className="text-xs text-muted ml-0.5">tok/s</span></> : <span className="text-muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {tab === "providers" && (
                    <>
                      <thead>
                        <tr className="border-b border-line">
                          <th className={cx(th, "text-left")}>Provider</th>
                          <th className={cx(th, "text-right")}>模型</th>
                          <th className={cx(th, "text-right")}>请求</th>
                          <th className={cx(th, "text-right")}>Tokens</th>
                          <th className={cx(th, "text-right")}>缓存命中</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.providers.map((p) => (
                          <tr key={p.provider} className="border-b border-line last:border-0">
                            <td className={td}>{p.name}</td>
                            <td className={cx(td, "text-right")}>{p.models}</td>
                            <td className={cx(td, "text-right")}>{p.requests}</td>
                            <td className={cx(td, "text-right")}>{tokens(p.input + p.output)}</td>
                            <td className={cx(td, "text-right")}>{pct(p.input ? p.cached / p.input : null)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {tab === "agents" && (
                    <>
                      <thead>
                        <tr className="border-b border-line">
                          <th className={cx(th, "text-left")}>agent</th>
                          <th className={cx(th, "text-right")}>请求</th>
                          <th className={cx(th, "text-right")}>Tokens</th>
                          <th className={cx(th, "text-right")}>费用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.agents.map((a) => (
                          <tr key={a.agentId} className="border-b border-line last:border-0">
                            <td className={cx(td, "max-w-48 truncate")}>
                              {a.emoji} {a.name}
                            </td>
                            <td className={cx(td, "text-right")}>{a.requests}</td>
                            <td className={cx(td, "text-right")}>{tokens(a.input + a.output)}</td>
                            <td className={cx(td, "text-right")}>{a.spendUsd != null ? `$${a.spendUsd.toFixed(2)}` : <span className="text-muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </SettingGroup>
  );
}

function LearningSection({ s, save }: { s: SettingsView; save: Save }) {
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: () => api.get<Schedule[]>("/api/schedules") });
  const curate = schedules.data?.find((x) => x.id === "sys-curate");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <SettingGroup title="复盘">
        <SettingRow title="任务结束后自动复盘" desc="把值得留下的经验写进记忆，把可复用的流程写成技能。点 👍 / 👎 时无论开关都会复盘。">
          <Toggle checked={s.autoReflect} onChange={(v) => void save({ autoReflect: v }, v ? "已开启自动复盘" : "已关闭自动复盘")} label="任务结束后自动复盘" />
        </SettingRow>
        {s.autoReflect && (
          <SettingRow title="复盘门槛" desc="成功完成、且调用工具达到这个次数的任务才自动复盘；简单问答不值得花这份钱。">
            <Choice
              label="复盘门槛"
              value={s.reflectMinToolCalls}
              options={[1, 3, 5, 10, 20].map((n) => ({ value: n, label: `${n} 次工具调用` }))}
              onChange={(v) => void save({ reflectMinToolCalls: v })}
            />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup title="整理">
        <SettingRow
          title="每周整理记忆和技能"
          desc={`每周一 04:00 合并重复、删掉过时的记忆，清理 60 天没用过的技能。${curate?.last ? `上次：${timeAgo(curate.last.fired_at)}${curate.last.ok ? "" : "（失败）"}` : "还没有整理过。"}`}
        >
          {curate && (
            <Toggle
              checked={!!curate.enabled}
              label="每周整理记忆和技能"
              onChange={(v) => void api.patch(`/api/schedules/${curate.id}`, { enabled: v }).then(() => qc.invalidateQueries({ queryKey: ["schedules"] }))}
            />
          )}
        </SettingRow>
        <SettingRow title="立即整理" desc="对所有 agent 跑一遍，可能要几分钟。每一步改动都能在「学习」页查看和撤销。">
          <Button
            size="sm"
            variant="soft"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ ok: boolean; detail?: string }>("/api/schedules/sys-curate/run");
                toast(r.ok ? "整理完成" : `整理失败：${r.detail ?? ""}`, r.ok ? "ok" : "danger");
                void qc.invalidateQueries({ queryKey: ["schedules"] });
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), "danger");
              } finally {
                setBusy(false);
              }
            }}
          >
            立即整理
          </Button>
        </SettingRow>
        <SettingRow title="学习记录" desc="每次复盘和整理具体改了什么。">
          <Link to="/learning" className="text-[13px] text-muted hover:text-[var(--text)]">
            查看 ›
          </Link>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

const PALETTES: { value: Appearance["palette"]; label: string; swatch: [string, string] }[] = [
  { value: "nebula", label: "星云", swatch: ["#8b5cf6", "#ec4899"] },
  { value: "clay", label: "陶土", swatch: ["#c96442", "#d97757"] },
  { value: "ocean", label: "海洋", swatch: ["#2563eb", "#06b6d4"] },
];

function AppearanceSection() {
  const a = useAppearance();
  return (
    <>
      <SettingGroup title="外观">
        <SettingRow wide title="主题" desc="只对这台设备生效。">
          <div className="w-60">
            <Segmented
              value={a.theme}
              options={[
                { value: "system", label: "跟随系统" },
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
              ]}
              onChange={(theme) => setAppearance({ theme })}
            />
          </div>
        </SettingRow>
        <SettingRow wide title="配色" desc="主色和中性色的搭配。">
          <div className="flex gap-1.5">
            {PALETTES.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={a.palette === p.value}
                onClick={() => setAppearance({ palette: p.value })}
                className={cx(
                  "flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-[13px] transition-colors",
                  a.palette === p.value ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : "border-line hover:bg-surface-2",
                )}
              >
                <span className="size-3.5 rounded-full shrink-0" style={{ background: `linear-gradient(135deg, ${p.swatch[0]}, ${p.swatch[1]})` }} />
                {p.label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow wide title="标题与回复字体" desc="页面标题和 agent 回复正文用的字体。">
          <div className="w-40">
            <Segmented
              value={a.font}
              options={[
                { value: "sans", label: "无衬线" },
                { value: "serif", label: "衬线" },
              ]}
              onChange={(font) => setAppearance({ font })}
            />
          </div>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="对话">
        <SettingRow title="显示用量" desc="在输入框旁显示上下文占用和输出速度，在每次回复下方显示 token 数和耗时。">
          <Toggle checked={a.usage} onChange={(usage) => setAppearance({ usage })} label="对话中显示用量" />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

const NOTIFY_KINDS: { kind: NotifyKind; title: string; desc: string }[] = [
  { kind: "approval", title: "审批和选择", desc: "agent 要做需要你批准的操作，或请你在几个选项里做决定时。" },
  { kind: "done", title: "任务完成", desc: "运行超过 1 分钟的任务，以及定时、自动继续的任务完成时。" },
  { kind: "failed", title: "任务失败", desc: "任务出错停下、生成了诊断报告时（会被自动继续的中断不推送）。" },
  { kind: "stuck", title: "任务卡住", desc: "监督员处理不了、需要你决定时。" },
];

function NotifySection({ s, save }: { s: SettingsView; save: Save }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [tg, setTg] = useState(false);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(s.telegramChatId);
  const devices = useQuery({ queryKey: ["push-devices"], queryFn: () => api.get<{ endpoint: string; device: string; created_at: string }[]>("/api/push/devices") });
  useEffect(() => {
    void currentSubscription().then((sub) => setOn(!!sub));
  }, []);
  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      if (v) await enablePush(/Android/.test(navigator.userAgent) ? "Android 手机" : /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "浏览器");
      else await disablePush();
      setOn(v);
      void devices.refetch();
      toast(v ? "已开启推送" : "已关闭推送");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingGroup title="推送">
        <SettingRow title="这台设备接收推送" desc={pushSupported() ? "审批请求、任务完成、提醒都会推送到这里。" : "当前浏览器不支持；请用 Chrome 打开并添加到主屏幕。"}>
          {on !== null && <Toggle checked={on} onChange={(v) => !busy && void toggle(v)} label="接收推送" />}
        </SettingRow>
        <SettingRow title={`已登记设备 · ${devices.data?.length ?? 0}`} desc="所有接收推送的设备。">
          <Button
            size="sm"
            variant="soft"
            onClick={() => void api.post<{ push: number }>("/api/push/test").then((r) => toast(r.push ? `已发送到 ${r.push} 台设备` : "没有可用的推送设备", r.push ? "ok" : "danger"))}
          >
            发送测试
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="推送哪些事">
        {NOTIFY_KINDS.map((k) => (
          <SettingRow key={k.kind} title={k.title} desc={k.desc}>
            <Toggle checked={s.notifyOn[k.kind]} onChange={(v) => void save({ notifyOn: { [k.kind]: v } })} label={`推送${k.title}`} />
          </SettingRow>
        ))}
        <div className="py-2 text-xs text-muted">关掉的事项不再推送到设备，但仍会记在 App 的通知里。你设的定时提醒总会推送。</div>
      </SettingGroup>
      <SettingGroup title="免打扰">
        <SettingRow title="免打扰时段" desc="这段时间里推送静音到达、不发 Telegram；你设的定时提醒照常响铃。">
          <Toggle checked={s.quietHours.enabled} onChange={(v) => void save({ quietHours: { enabled: v } }, v ? "已开启免打扰" : "已关闭免打扰")} label="免打扰时段" />
        </SettingRow>
        {s.quietHours.enabled && (
          <SettingRow title="时段" desc={`按服务器时区（${s.timezone}），可以跨过午夜。`}>
            <input
              type="time"
              aria-label="开始时间"
              className={cx(inputClass, "w-28")}
              defaultValue={s.quietHours.start}
              onBlur={(e) => e.target.value && e.target.value !== s.quietHours.start && void save({ quietHours: { start: e.target.value } })}
            />
            <span className="text-muted">–</span>
            <input
              type="time"
              aria-label="结束时间"
              className={cx(inputClass, "w-28")}
              defaultValue={s.quietHours.end}
              onBlur={(e) => e.target.value && e.target.value !== s.quietHours.end && void save({ quietHours: { end: e.target.value } })}
            />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup title="备用渠道">
        <SettingRow title="Telegram" desc={s.telegramConfigured ? `已配置 · chat ${s.telegramChatId}` : "可选：推送失败或紧急提醒时同时发 Telegram。"}>
          <Button size="sm" variant="soft" onClick={() => setTg(true)}>
            {s.telegramConfigured ? "修改" : "设置"}
          </Button>
        </SettingRow>
      </SettingGroup>
      <Sheet open={tg} onClose={() => setTg(false)} title="Telegram 备用通知">
        <div className="space-y-3">
          <Field label="Bot Token" hint="在 @BotFather 创建机器人获得。留空保存可清除">
            <input className={cx(inputClass, "font-mono")} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Chat ID" hint="先给机器人发一条消息，再用 @userinfobot 查自己的 ID">
            <input className={inputClass} value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </Field>
          <Button variant="primary" className="w-full" onClick={() => void save({ telegramBotToken: token, telegramChatId: chatId }).then(() => setTg(false))}>
            保存
          </Button>
        </div>
      </Sheet>
    </>
  );
}

interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  detail: string | null;
}

const AUDIT_TEXT: Record<string, string> = {
  "auth.setup": "创建账号",
  "auth.login": "登录",
  "auth.password.change": "修改密码",
  "auth.totp.enable": "开启两步验证",
  "auth.totp.disable": "关闭两步验证",
  "auth.passkey.add": "添加通行密钥",
  "auth.passkey.delete": "删除通行密钥",
  "auth.session.revoke": "下线设备",
  "agent.create": "新建 agent",
  "agent.update": "修改 agent",
  "agent.archive": "删除 agent",
  "agent.secret.set": "设置 agent 密钥",
  "agent.secret.delete": "删除 agent 密钥",
  "agent.newapi_token": "生成 agent 专属令牌",
  "approval.approve": "批准操作",
  "approval.deny": "拒绝操作",
  "run.interrupt": "停止任务",
  "desktop.create": "新建桌面",
  "desktop.delete": "删除桌面",
  "desktop.takeover": "接管桌面",
  "desktop.handback": "交还桌面",
  "schedule.create": "新建定时任务",
  "schedule.update": "修改定时任务",
  "schedule.delete": "删除定时任务",
  "settings.update": "修改设置",
  "provider.create": "添加 provider",
  "provider.update": "修改 provider",
  "provider.delete": "删除 provider",
  "models.add": "添加模型",
  "models.remove": "移除模型",
};

/** Field names in settings.update / agent.update details. */
const FIELD_TEXT: Record<string, string> = {
  defaultModel: "默认模型",
  reflectModel: "复盘模型",
  defaultEffort: "默认推理强度",
  autoResume: "自动继续",
  maxAutoResumes: "连续无进展上限",
  runTimeoutMinutes: "单轮最长运行",
  runWatchdogMinutes: "卡住处理",
  approvalMode: "审批方式",
  agentIdleMinutes: "agent 闲置休眠",
  desktopIdleMinutes: "桌面闲置关闭",
  autoReflect: "自动复盘",
  reflectMinToolCalls: "复盘门槛",
  notifyOn: "推送事项",
  quietHours: "免打扰",
  backupKeep: "备份保留",
  modelNameFormat: "显示名格式",
  newapiAdminToken: "new-api 管理令牌",
  newapiAdminUserId: "new-api 用户 ID",
  telegramBotToken: "Telegram",
  telegramChatId: "Telegram",
  name: "名字",
  emoji: "图标",
  template: "模板",
  persona: "人设",
  model: "模型",
  effort: "推理强度",
  approvalPolicy: "命令审批",
  desktopPolicy: "桌面",
  hostAccess: "宿主机权限",
  budgetDailyUsd: "每日预算",
};

function AuditList({ rows, agents }: { rows: AuditRow[]; agents: Agent[] }) {
  const who = (actor: string) =>
    actor === "policy" ? "自动审批" : actor === "watchdog" ? "超时保护" : actor.startsWith("us_") ? "你" : (agents.find((a) => a.id === actor)?.name ?? actor);
  const extra = (r: AuditRow) => {
    try {
      const d = r.detail ? JSON.parse(r.detail) : null;
      if (Array.isArray(d?.fields)) return [...new Set(d.fields.map((f: string) => FIELD_TEXT[f] ?? f))].join("、");
      return d?.name ?? d?.ip ?? d?.ref ?? (r.action.startsWith("provider.") ? d?.id : null);
    } catch {
      return null;
    }
  };
  return (
    <>
      {rows.map((r) => (
        <SettingRow dense key={r.id} title={<span className="font-normal">{AUDIT_TEXT[r.action] ?? r.action}</span>} desc={[timeAgo(r.ts), who(r.actor), extra(r)].filter(Boolean).join(" · ")} />
      ))}
    </>
  );
}

function SecuritySection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [totp, setTotp] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState<{ current: string; next: string } | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditRow[]>("/api/audit") });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["me"] });
  const wrap = (fn: () => Promise<unknown>, ok: string) => async () => {
    try {
      await fn();
      toast(ok);
      void refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  const addPasskey = wrap(async () => {
    const { key, options } = await api.post<{ key: string; options: any }>("/api/auth/passkey/register/options");
    const response = await startRegistration({ optionsJSON: options });
    const name = /Android/.test(navigator.userAgent) ? "Android 手机" : /iPhone/.test(navigator.userAgent) ? "iPhone" : "这台设备";
    await api.post("/api/auth/passkey/register/verify", { key, response, name });
  }, "已添加通行密钥");
  return (
    <>
      <SettingGroup title="登录">
        <SettingRow title={`通行密钥 · ${me.passkeys.length}`} desc="用指纹 / 面容登录，比密码更安全。">
          <Button size="sm" variant="soft" onClick={addPasskey}>
            添加
          </Button>
        </SettingRow>
        {me.passkeys.map((p) => (
          <SettingRow dense key={p.id} title={<span className="font-normal pl-4">{p.name}</span>} desc={<span className="pl-4">{`${p.rp_id} · ${p.last_used_at ? `上次使用 ${timeAgo(p.last_used_at)}` : "未使用"}`}</span>}>
            <Button size="sm" variant="ghost" className="text-danger" onClick={wrap(() => api.del(`/api/auth/passkeys/${encodeURIComponent(p.id)}`), "已删除")}>
              删除
            </Button>
          </SettingRow>
        ))}
        <SettingRow title="两步验证（TOTP）" desc={me.totp ? "已开启：密码登录时需要验证码。" : "未开启。开启后密码登录还需要验证器里的 6 位数字。"}>
          {me.totp ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() => {
                const password = prompt("输入密码以关闭两步验证");
                if (password) void wrap(() => api.post("/api/auth/totp/disable", { password }), "已关闭")();
              }}
            >
              关闭
            </Button>
          ) : (
            <Button
              size="sm"
              variant="soft"
              onClick={async () => {
                const t = await api.post<{ secret: string; uri: string }>("/api/auth/totp/begin");
                setTotp({ ...t, qr: await QRCode.toDataURL(t.uri, { margin: 1, width: 220 }) });
              }}
            >
              开启
            </Button>
          )}
        </SettingRow>
        <SettingRow title="密码">
          <Button size="sm" variant="soft" onClick={() => setPw({ current: "", next: "" })}>
            修改密码
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="登录中的设备">
        {me.sessions.map((sess) => (
          <SettingRow
            dense
            key={sess.id}
            title={
              <span className="flex items-center gap-1.5">
                {sess.device} {sess.current && <Badge tone="ok">当前</Badge>}
              </span>
            }
            desc={`${sess.ip} · ${timeAgo(sess.last_seen_at)}`}
          >
            {!sess.current && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={wrap(() => api.del(`/api/auth/sessions/${sess.id}`), "已下线")}>
                下线
              </Button>
            )}
          </SettingRow>
        ))}
      </SettingGroup>
      <SettingGroup title="操作记录">
        <AuditList rows={(audit.data ?? []).slice(0, 6)} agents={agents.data ?? []} />
        <SettingRow title={`最近 ${audit.data?.length ?? 0} 条`} desc="登录、审批、改设置、管理 agent 等操作都会记下来。">
          <Button size="sm" variant="soft" onClick={() => setAuditOpen(true)}>
            查看全部
          </Button>
        </SettingRow>
      </SettingGroup>
      <Sheet open={auditOpen} onClose={() => setAuditOpen(false)} title="操作记录">
        <div className="divide-y divide-[var(--border)]">
          <AuditList rows={audit.data ?? []} agents={agents.data ?? []} />
        </div>
      </Sheet>
      <Sheet open={!!totp} onClose={() => setTotp(null)} title="开启两步验证">
        {totp && (
          <div className="space-y-3">
            <img src={totp.qr} alt="TOTP 二维码" className="mx-auto rounded-lg bg-white p-2" />
            <div className="text-xs text-muted text-center break-all font-mono">{totp.secret}</div>
            <Field label="验证器里显示的 6 位数字">
              <input className={inputClass} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              className="w-full"
              onClick={() =>
                void wrap(() => api.post("/api/auth/totp/enable", { secret: totp.secret, code }), "已开启两步验证")().then(() => {
                  setTotp(null);
                  setCode("");
                })
              }
            >
              确认开启
            </Button>
          </div>
        )}
      </Sheet>
      <Sheet open={!!pw} onClose={() => setPw(null)} title="修改密码">
        {pw && (
          <div className="space-y-3">
            <Field label="当前密码">
              <input className={inputClass} type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
            </Field>
            <Field label="新密码" hint="至少 10 位">
              <input className={inputClass} type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
            </Field>
            <Button variant="primary" className="w-full" onClick={() => void wrap(() => api.post("/api/auth/password", pw), "已修改")().then(() => setPw(null))}>
              保存
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

function SystemSection({ s, save }: { s: SettingsView; save: Save }) {
  const sys = useQuery({
    queryKey: ["system"],
    queryFn: () =>
      api.get<{
        disk: { freeGb: number; totalGb: number };
        dbSizeMb: number;
        containers: { name: string; state: string; status: string; role: string }[];
        backups: { name: string; size: number }[];
        newapi: { ok: boolean; models?: number; error?: string };
        version: string;
      }>("/api/system"),
  });
  const [busy, setBusy] = useState(false);
  if (!sys.data) return <Loading />;
  const d = sys.data;
  const idle = minuteOptions([10, 30, 60, 120, 360, 0], "一直开着");
  return (
    <>
      <SettingGroup title={`系统 · v${d.version}`}>
        <SettingRow title="new-api" desc={d.newapi.ok ? `${d.newapi.models} 个模型可用` : d.newapi.error}>
          <Badge tone={d.newapi.ok ? "ok" : "danger"}>{d.newapi.ok ? "正常" : "异常"}</Badge>
        </SettingRow>
        <SettingRow title="磁盘与数据库" desc={`剩余 ${d.disk.freeGb} / ${d.disk.totalGb} GB · 数据库 ${d.dbSizeMb} MB`} />
      </SettingGroup>
      <SettingGroup title="备份">
        <SettingRow title="自动备份" desc={d.backups[0] ? `每天 03:30 · 最近：${d.backups[0].name}（${(d.backups[0].size / 1e6).toFixed(1)} MB）· 现有 ${d.backups.length} 份` : "每天 03:30 自动备份，还没有备份。"}>
          <Button
            size="sm"
            variant="soft"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ file: string }>("/api/system/backup");
                toast(`已备份：${r.file}`);
                void sys.refetch();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), "danger");
              } finally {
                setBusy(false);
              }
            }}
          >
            立即备份
          </Button>
        </SettingRow>
        <SettingRow title="保留份数" desc="数据库、记忆和技能打包备份，超过的旧备份自动删除。">
          <Choice label="保留份数" value={s.backupKeep} options={[3, 7, 14, 30].map((n) => ({ value: n, label: `${n} 份` }))} onChange={(v) => void save({ backupKeep: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="资源">
        <SettingRow title="agent 闲置休眠" desc="agent 容器这么久没活干就停掉省内存，下次发消息时自动启动（多等几秒）。">
          <Choice label="agent 闲置休眠" value={s.agentIdleMinutes} options={idle} onChange={(v) => void save({ agentIdleMinutes: v })} />
        </SettingRow>
        <SettingRow title="桌面闲置关闭" desc="桌面这么久没人用就关掉，浏览器登录状态会保留。">
          <Choice label="桌面闲置关闭" value={s.desktopIdleMinutes} options={idle} onChange={(v) => void save({ desktopIdleMinutes: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="环境">
        <SettingRow title="时区" desc="定时任务、用量统计、免打扰都按它算；在 deploy/.env 的 TZ 里改。">
          <span className="text-[13px] text-muted">{s.timezone}</span>
        </SettingRow>
        <SettingRow title="访问地址" desc={<span className="font-mono break-all">{s.origins.join("、")}</span>} />
        <SettingRow title="数据目录" desc={<span className="font-mono">{s.dataDir}</span>} />
      </SettingGroup>
      <SettingGroup title="容器">
        {d.containers.map((c) => (
          <SettingRow dense key={c.name} title={<span className="font-mono text-[12.5px] font-normal">{c.name}</span>} desc={c.status}>
            <Badge tone={c.state === "running" ? "ok" : "muted"}>{c.role}</Badge>
          </SettingRow>
        ))}
      </SettingGroup>
    </>
  );
}
