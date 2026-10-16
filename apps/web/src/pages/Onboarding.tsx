import { FileText, Globe2, Monitor, Server, Smartphone, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, Card, Checkbox, Field, Loading, Select, StatusText, cx, inputClass } from "../components/ui";
import { api } from "../lib/api";
import type { HostCaps } from "../lib/types";

type Choice = "browser" | "desktop" | "android" | "office";
type Selection = Record<Choice, boolean>;

interface OfficeStatus {
  enabled: boolean;
  imagePresent: boolean;
  imageSizeMb: number | null;
  state: "off" | "stopped" | "starting" | "running" | "error";
  pulling: { active: boolean; percent: number; error: string | null };
}

interface OnboardingData {
  needed: boolean;
  selection: Selection;
  pendingOffice: boolean;
  /** Whether a model upstream is already configured (env or an earlier run). */
  modelConfigured: boolean;
  images: { agent: boolean; desktop: boolean; office: boolean };
  capabilities: HostCaps;
  office: OfficeStatus;
}

const OPTIONS: { id: Choice; title: string; description: string; detail: string; icon: typeof Globe2 }[] = [
  { id: "browser", title: "浏览器实例", description: "网页任务的轻量浏览器", detail: "适合查资料、填表和处理网页业务。", icon: Globe2 },
  { id: "desktop", title: "Linux 桌面", description: "完整的桌面与 Chromium", detail: "需要运行桌面程序或接管鼠标键盘时使用。", icon: Monitor },
  { id: "android", title: "安卓实例", description: "运行 Android App", detail: "需要宿主机支持 binder 或 KVM，并提前构建安卓系统镜像。", icon: Smartphone },
  { id: "office", title: "在线 Office", description: "直接编辑 Word / Excel / PowerPoint", detail: "使用 OnlyOffice，约需 3 GB 镜像和 2 GB 以上运行内存。", icon: FileText },
];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const q = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingData>("/api/onboarding"),
    refetchInterval: (query) => (query.state.data?.pendingOffice ? 2000 : 10_000),
  });
  const [selection, setSelection] = useState<Selection>({ browser: true, desktop: true, android: false, office: true });
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  // Model upstream: any OpenAI Responses-compatible address; optional, but without one agents can't run.
  const [mName, setMName] = useState("默认服务商");
  const [mBaseUrl, setMBaseUrl] = useState("");
  const [mKey, setMKey] = useState("");
  const [mModel, setMModel] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");

  useEffect(() => {
    if (q.data?.selection && !started) setSelection(q.data.selection);
  }, [q.data?.selection, started]);
  useEffect(() => {
    if (q.data?.pendingOffice) setStarted(!q.data.office.pulling.error);
  }, [q.data?.pendingOffice, q.data?.office.pulling.error]);
  useEffect(() => {
    if (q.data && !q.data.needed) onDone();
  }, [q.data, onDone]);

  if (!q.data) return <Loading />;
  const d = q.data;
  const androidUnavailable = d.capabilities.checkedAt !== null && !d.capabilities.kinds.android.ok;
  const set = (id: Choice) => setSelection((s) => ({ ...s, [id]: !s[id] }));
  const fetchModels = async () => {
    setProbing(true);
    setProbeError("");
    try {
      const r = await api.post<{ models: string[] }>("/api/onboarding/models", { baseUrl: mBaseUrl.trim(), apiKey: mKey });
      setModels(r.models);
      if (r.models.length && !mModel.trim()) setMModel(r.models[0]!);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };
  const modelIncomplete = !!mBaseUrl.trim() !== !!mModel.trim();
  const submit = async () => {
    setStarted(true);
    setError("");
    try {
      const model = mBaseUrl.trim() && mModel.trim() ? { name: mName.trim() || undefined, baseUrl: mBaseUrl.trim(), apiKey: mKey, model: mModel.trim() } : null;
      await api.post("/api/onboarding", { ...selection, model });
      await q.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarted(false);
    }
  };
  const office = d.office;
  const officeProgress = office.pulling.active ? office.pulling.percent : office.imagePresent ? 100 : 0;
  const imageReady = d.images.agent && (!selection.browser && !selection.desktop || d.images.desktop);

  return (
    <main className="min-h-full overflow-y-auto px-4 py-10 safe-top safe-bottom">
      <div className="mx-auto w-full max-w-2xl space-y-7">
        <header className="text-center space-y-3">
          <img src="/icon.svg" alt="" className="size-16 mx-auto rounded-[18px] shadow-lg" />
          <div>
            <h1 className="font-display text-2xl font-semibold">欢迎使用 Constella</h1>
            <p className="text-muted mt-1">先选好你需要的能力，确认后系统会把第一套环境准备好。</p>
          </div>
        </header>

        <Card className="p-4 sm:p-5 space-y-3">
          <div>
            <h2 className="font-semibold">需要哪些功能？</h2>
            <p className="text-[13px] text-muted mt-1">实例和 Office 后续仍可在「实例」与「设置」里管理。首次部署不会创建 agent，只会准备选中的实例和工具。</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const disabled = option.id === "android" && androidUnavailable;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => set(option.id)}
                  className={cx(
                    "text-left rounded-xl border p-3 transition-colors",
                    selection[option.id] ? "border-[var(--color-accent)] bg-accent-soft ring-1 ring-[var(--color-accent)]" : "border-line hover:bg-surface-2",
                    disabled && "opacity-55 cursor-not-allowed",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="size-9 rounded-lg bg-surface-2 grid place-items-center shrink-0"><Icon className="size-4" /></span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 font-medium">
                        {option.title}
                        <Checkbox checked={selection[option.id]} onChange={() => set(option.id)} disabled={disabled} label={`选择${option.title}`} />
                      </span>
                      <span className="block text-[13px] mt-0.5">{option.description}</span>
                      <span className="block text-xs text-muted mt-1 leading-5">{option.detail}</span>
                      {option.id === "android" && disabled && <span className="block text-xs text-danger mt-1">当前宿主机不可用：{d.capabilities.kinds.android.reason}</span>}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="p-4 sm:p-5 space-y-3">
          <div>
            <h2 className="font-semibold">模型服务</h2>
            <p className="text-[13px] text-muted mt-1">
              任何兼容 OpenAI Responses API 的地址都可以：官方 API、自建网关、聚合服务。可以跳过，之后在「设置 → 模型」里配置；不配置 agent 跑不起来。
            </p>
          </div>
          {d.modelConfigured ? (
            <StatusText tone="ok">模型服务已配置</StatusText>
          ) : (
            <div className="space-y-3">
              <Field label="名称" hint="只用于显示，比如 CLIProxy">
                <input className={inputClass} value={mName} onChange={(e) => setMName(e.target.value)} maxLength={40} />
              </Field>
              <Field label="接口地址" hint="一般以 /v1 结尾；容器里的 localhost 不是宿主机，宿主机用 host.docker.internal">
                <input className={cx(inputClass, "font-mono")} value={mBaseUrl} onChange={(e) => setMBaseUrl(e.target.value)} placeholder="http://host.docker.internal:3000/v1" autoComplete="off" />
              </Field>
              <Field label="API Key" hint="没有可以留空">
                <input className={cx(inputClass, "font-mono")} type="password" value={mKey} onChange={(e) => setMKey(e.target.value)} autoComplete="off" />
              </Field>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  {models ? (
                    <Field label="模型">
                      <Select label="模型" value={mModel} onChange={setMModel} options={models.map((m) => ({ value: m, label: m }))} />
                    </Field>
                  ) : (
                    <Field label="模型" hint={mBaseUrl.trim() ? "点「获取模型」读取，或直接填写" : "先填接口地址"}>
                      <input className={cx(inputClass, "font-mono")} value={mModel} onChange={(e) => setMModel(e.target.value)} placeholder="gpt-4o" autoComplete="off" />
                    </Field>
                  )}
                </div>
                <Button size="sm" variant="secondary" loading={probing} disabled={!mBaseUrl.trim()} onClick={() => void fetchModels()}>
                  获取模型
                </Button>
              </div>
              {probeError && <div className="text-xs text-danger">{probeError}</div>}
              {modelIncomplete && <div className="text-xs text-warn">接口地址和模型要么都填，要么都留空。</div>}
            </div>
          )}
        </Card>

        <Card className="p-4 sm:p-5 space-y-3">
          <h2 className="font-semibold">部署检查</h2>
          <StatusText tone={d.images.agent ? "ok" : "danger"}>
            {d.images.agent ? "agent 运行镜像已就绪" : "缺少 agent 运行镜像，请在服务器执行 scripts/install.sh"}
          </StatusText>
          <StatusText tone={d.images.desktop ? "ok" : "danger"}>
            {d.images.desktop ? "浏览器 / Linux 桌面镜像已就绪" : "缺少浏览器 / Linux 桌面镜像，请在服务器执行 scripts/install.sh"}
          </StatusText>
          {selection.android && <StatusText tone={d.capabilities.kinds.android.ok ? "ok" : "warn"}>{d.capabilities.kinds.android.ok ? "安卓实例环境可用" : d.capabilities.kinds.android.reason ?? "正在检测安卓环境"}</StatusText>}
          {selection.office && (
            <StatusText tone={office.pulling.active ? "busy" : office.imagePresent ? "ok" : office.pulling.error ? "danger" : "warn"}>
              {office.pulling.active ? `在线 Office 正在下载 · ${officeProgress}%` : office.imagePresent ? "在线 Office 镜像已就绪" : office.pulling.error ? `在线 Office 下载失败：${office.pulling.error}` : "在线 Office 等待部署"}
            </StatusText>
          )}
          {!imageReady && <div className="flex items-start gap-2 text-xs text-warn"><TriangleAlert className="size-4 shrink-0" />当前运行中的 hub 不是完整一键部署，先补齐镜像后再确认。</div>}
        </Card>

        {started && d.pendingOffice && (
          <Card className="p-4 border-[var(--color-accent)] space-y-2">
            <div className="flex items-center gap-2 font-medium"><Server className="size-4" />正在完成部署</div>
            <div className="h-2 rounded-full bg-surface-2 overflow-hidden"><div className="h-full bg-accent-grad transition-all" style={{ width: `${officeProgress}%` }} /></div>
            <p className="text-xs text-muted">Office 镜像较大，下载完成前请不要关闭服务器。页面会自动继续。</p>
          </Card>
        )}

        {error && <div className="text-sm text-danger text-center">{error}</div>}
        <Button variant="primary" size="lg" className="w-full" loading={started} disabled={!imageReady || modelIncomplete || (selection.android && androidUnavailable)} onClick={() => void submit()}>
          {started ? "部署中…" : "确认并开始部署"}
        </Button>
        <p className="text-center text-xs text-muted">部署完成后会进入首页。Office 会在需要时自动启动，不使用时可以自动释放内存。</p>
      </div>
    </main>
  );
}
