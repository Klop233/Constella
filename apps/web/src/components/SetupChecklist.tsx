import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/api";
import { useModels } from "../lib/models";
import { currentSubscription, enablePush, pushSupported } from "../lib/push";
import { ModelConnect } from "./ModelConnect";
import { Button, Card, Section, SectionLink, Sheet, cx, toast } from "./ui";

const DISMISS_KEY = "constella.setupDismissed";

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

interface Item {
  id: string;
  done: boolean;
  /** Blocks using the app at all: shown even after 「以后再说」, in the danger colour. */
  blocking?: boolean;
  title: string;
  desc: ReactNode;
  action?: ReactNode;
}

const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const standalone = typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
const https = typeof location !== "undefined" && location.protocol === "https:";

/** What's left before Constella is really usable on this device; hides itself once everything is done. */
export function SetupChecklist({ agents }: { agents: number }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const models = useModels();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ defaultModel: string; modelSeedError: string | null }>("/api/settings") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ name: string; passkeys: unknown[] }>("/api/me"), staleTime: 300_000 });
  const push = useQuery({ queryKey: ["push-subscription"], queryFn: async () => !!(await currentSubscription()), enabled: pushSupported() });
  const [hidden, setHidden] = useState(dismissed);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState("");

  if (!models.data || !settings.data || !me.data) return null;
  const def = models.data.find((m) => m.ref === settings.data.defaultModel);
  const modelOk = !!def?.test?.ok;

  const testDefault = async () => {
    if (!def) return;
    setBusy("test");
    const r = await api.post<{ ok: boolean; error: string | null }>("/api/models/test", { ref: def.ref }).catch((e) => ({ ok: false, error: String(e.message ?? e) }));
    setBusy("");
    void qc.invalidateQueries({ queryKey: ["models"] });
    if (!r.ok) toast(`测试没有通过：${r.error}`, "danger");
  };
  const turnOnPush = async () => {
    setBusy("push");
    try {
      await enablePush(/Android/.test(navigator.userAgent) ? "Android 手机" : /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "浏览器");
      toast("已开启推送");
      void qc.invalidateQueries({ queryKey: ["push-subscription"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy("");
    }
  };

  const items: Item[] = [
    {
      id: "model",
      done: modelOk,
      blocking: true,
      title: "连接模型",
      desc: modelOk
        ? `默认模型 ${def!.label} 可用`
        : def
          ? def.test
            ? `默认模型 ${def.label} 测试没有通过：${def.test.error ?? "未知原因"}`
            : `默认模型 ${def.label} 还没有测试`
          : (settings.data.modelSeedError ?? "还没有可用的模型：添加一个服务商，填上 API Key"),
      action: modelOk ? undefined : def && !def.test ? (
        <Button size="sm" variant="secondary" loading={busy === "test"} onClick={() => void testDefault()}>
          测试
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setConnecting(true)}>
          连接
        </Button>
      ),
    },
    {
      id: "agent",
      done: agents > 0,
      title: "新建第一个 agent",
      desc: "从模板开始，名字改一下就能用",
      action: (
        <Button size="sm" variant="secondary" onClick={() => nav("/agents/new")}>
          新建
        </Button>
      ),
    },
  ];
  if (!https)
    items.push({
      id: "https",
      done: false,
      title: "用 HTTPS 地址访问",
      desc: "手机推送和指纹登录都要求 HTTPS：用 Cloudflare Tunnel 或 Tailscale 配一个入口，见 README「部署」第 3 步",
    });
  if (pushSupported())
    items.push({
      id: "push",
      done: !!push.data,
      title: "这台设备接收推送",
      desc: "任务做完、要你审批或回答时通知你",
      action: (
        <Button size="sm" variant="secondary" loading={busy === "push"} onClick={() => void turnOnPush()}>
          开启
        </Button>
      ),
    });
  if (window.PublicKeyCredential && window.isSecureContext)
    items.push({
      id: "passkey",
      done: me.data.passkeys.length > 0,
      title: "添加通行密钥",
      desc: "以后用指纹或面容登录；忘了密码时也多一条路",
      action: (
        <Button size="sm" variant="secondary" onClick={() => nav("/settings?s=security")}>
          添加
        </Button>
      ),
    });
  if (coarse)
    items.push({ id: "home", done: standalone, title: "添加到主屏幕", desc: "浏览器菜单里选「添加到主屏幕」，像 App 一样打开" });

  const left = items.filter((i) => !i.done);
  const shown = hidden ? left.filter((i) => i.blocking) : left.length ? items : [];
  if (!shown.length) return null;

  return (
    <Section
      title={`开始使用 · ${items.length - left.length}/${items.length}`}
      action={
        !hidden && !left.some((i) => i.blocking) ? (
          <SectionLink
            onClick={() => {
              try {
                localStorage.setItem(DISMISS_KEY, "1");
              } catch {}
              setHidden(true);
            }}
          >
            以后再说
          </SectionLink>
        ) : undefined
      }
    >
      <Card className="divide-y divide-[var(--border)] overflow-hidden">
        {shown.map((i) => {
          const Icon = i.done ? CheckCircle2 : i.blocking ? CircleAlert : Circle;
          return (
            <div key={i.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Icon className={cx("size-4 shrink-0", i.done ? "text-ok" : i.blocking ? "text-danger" : "text-muted")} />
              <div className="flex-1 min-w-0">
                <div className={cx("text-sm font-medium", i.done && "text-muted line-through decoration-[var(--border)]")}>{i.title}</div>
                {!i.done && <div className={cx("text-[13px] leading-5 break-words", i.blocking ? "text-danger" : "text-muted")}>{i.desc}</div>}
              </div>
              {!i.done && i.action}
            </div>
          );
        })}
      </Card>
      <Sheet open={connecting} onClose={() => setConnecting(false)} title="连接模型">
        <ModelConnect onDone={() => setConnecting(false)} />
      </Sheet>
    </Section>
  );
}
