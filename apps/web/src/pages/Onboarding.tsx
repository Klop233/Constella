import { Globe2, Monitor, Smartphone, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ModelConnect } from "../components/ModelConnect";
import { Button, Card, Checkbox, Loading, StatusText, cx } from "../components/ui";
import { api } from "../lib/api";
import { useModels } from "../lib/models";
import type { HostCaps } from "../lib/types";

type Choice = "browser" | "desktop" | "android";
type Selection = Record<Choice, boolean>;

interface OnboardingData {
  needed: boolean;
  selection: Selection;
  images: { agent: boolean; desktop: boolean };
  capabilities: HostCaps;
}

const OPTIONS: { id: Choice; title: string; description: string; detail: string; icon: typeof Globe2 }[] = [
  { id: "browser", title: "浏览器实例", description: "网页任务的轻量浏览器", detail: "适合查资料、填表和处理网页业务。", icon: Globe2 },
  { id: "desktop", title: "Linux 桌面", description: "完整的桌面与 Chromium", detail: "需要运行桌面程序或接管鼠标键盘时使用。", icon: Monitor },
  { id: "android", title: "安卓实例", description: "运行 Android App", detail: "需要宿主机支持 binder 或 KVM，并提前构建安卓系统镜像。", icon: Smartphone },
];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const q = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingData>("/api/onboarding"),
    refetchInterval: 10_000,
  });
  const [selection, setSelection] = useState<Selection>({ browser: true, desktop: true, android: false });
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<"model" | "features">("model");
  const [reconnect, setReconnect] = useState(false);
  const models = useModels();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ defaultModel: string }>("/api/settings") });
  const connected = models.data?.find((m) => m.ref === settings.data?.defaultModel && m.test?.ok);

  useEffect(() => {
    if (q.data?.selection && !started) setSelection(q.data.selection);
  }, [q.data?.selection, started]);
  useEffect(() => {
    if (q.data && !q.data.needed) onDone();
  }, [q.data, onDone]);

  if (!q.data || models.isLoading || settings.isLoading) return <Loading />;
  const d = q.data;
  const androidUnavailable = d.capabilities.checkedAt !== null && !d.capabilities.kinds.android.ok;
  const set = (id: Choice) => setSelection((s) => ({ ...s, [id]: !s[id] }));
  const submit = async () => {
    setStarted(true);
    setError("");
    try {
      await api.post("/api/onboarding", selection);
      await q.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarted(false);
    }
  };
  const imageReady = d.images.agent && (!selection.browser && !selection.desktop || d.images.desktop);

  return (
    <main className="min-h-full overflow-y-auto px-4 py-10 safe-top safe-bottom">
      <div className="mx-auto w-full max-w-2xl space-y-7">
        <header className="text-center space-y-3">
          <img src="/icon.svg" alt="" className="size-16 mx-auto rounded-[18px] shadow-lg" />
          <div>
            <h1 className="font-display text-2xl font-semibold">欢迎使用 Constella</h1>
            <p className="text-muted mt-1">先连上一个模型，再选需要的能力，确认后系统会把第一套环境准备好。</p>
          </div>
          <div className="flex items-center justify-center gap-2 text-[13px]">
            <button type="button" onClick={() => setStep("model")} className={step === "model" ? "font-medium" : "text-muted hover:text-[var(--text)]"}>
              1 连接模型
            </button>
            <span className="text-muted">·</span>
            <button type="button" onClick={() => setStep("features")} className={step === "features" ? "font-medium" : "text-muted hover:text-[var(--text)]"}>
              2 选择功能
            </button>
          </div>
        </header>

        {step === "model" && (
          <Card className="p-4 sm:p-5 space-y-3">
            <div>
              <h2 className="font-semibold">连接模型</h2>
              <p className="text-[13px] text-muted mt-1">和普通 AI 客户端一样：选一个服务商，填 API Key，挑一个模型。支持 OpenAI 兼容的 Chat Completions 和 Responses 接口。</p>
            </div>
            {connected && !reconnect ? (
              <div className="space-y-3">
                <StatusText tone="ok">已连接：{connected.label}</StatusText>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => setStep("features")}>
                    继续
                  </Button>
                  <Button variant="secondary" onClick={() => setReconnect(true)}>
                    换一个
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <ModelConnect
                  onDone={() => {
                    setReconnect(false);
                    setStep("features");
                  }}
                />
                <button type="button" className="block mx-auto text-[13px] text-muted hover:text-[var(--text)]" onClick={() => setStep("features")}>
                  稍后在「设置 → 模型」里配置
                </button>
              </>
            )}
          </Card>
        )}

        {step === "features" && (
          <>

            <Card className="p-4 sm:p-5 space-y-3">
              <div>
                <h2 className="font-semibold">需要哪些功能？</h2>
                <p className="text-[13px] text-muted mt-1">实例后续仍可在「实例」里管理。首次部署不会创建 agent，只会准备选中的实例。</p>
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
              <h2 className="font-semibold">部署检查</h2>
              <StatusText tone={d.images.agent ? "ok" : "danger"}>
                {d.images.agent ? "agent 运行镜像已就绪" : "缺少 agent 运行镜像，请在服务器执行 scripts/install.sh"}
              </StatusText>
              <StatusText tone={d.images.desktop ? "ok" : "danger"}>
                {d.images.desktop ? "浏览器 / Linux 桌面镜像已就绪" : "缺少浏览器 / Linux 桌面镜像，请在服务器执行 scripts/install.sh"}
              </StatusText>
              {selection.android && <StatusText tone={d.capabilities.kinds.android.ok ? "ok" : "warn"}>{d.capabilities.kinds.android.ok ? "安卓实例环境可用" : d.capabilities.kinds.android.reason ?? "正在检测安卓环境"}</StatusText>}
              {!imageReady && <div className="flex items-start gap-2 text-xs text-warn"><TriangleAlert className="size-4 shrink-0" />当前运行中的 hub 不是完整一键部署，先补齐镜像后再确认。</div>}
            </Card>

            {error && <div className="text-sm text-danger text-center">{error}</div>}
            <Button variant="primary" size="lg" className="w-full" loading={started} disabled={!imageReady || (selection.android && androidUnavailable)} onClick={() => void submit()}>
              {started ? "部署中…" : "确认并开始部署"}
            </Button>
            <p className="text-center text-xs text-muted">部署完成后会进入首页；Word / Excel / PowerPoint 成果可以直接在页面里查看和编辑。</p>
          </>
        )}
      </div>
    </main>
  );
}
