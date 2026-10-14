import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronRight, Gauge, KeyRound, LogOut, Palette, Server, Settings2, Shield, Sparkles, type LucideIcon } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ModelSelect } from "./AgentEdit";
import { Badge, Button, Field, Header, Loading, navItemClass, Segmented, SettingGroup, SettingRow, Sheet, Toggle, cx, inputClass, toast } from "../components/ui";
import { api, logout } from "../lib/api";
import { setAppearance, useAppearance, type Appearance } from "../lib/appearance";
import { timeAgo, tokens } from "../lib/format";
import { currentSubscription, disablePush, enablePush, pushSupported } from "../lib/push";
import type { Agent } from "../lib/types";

interface SettingsView {
  defaultModel: string;
  reflectModel: string;
  autoResume: boolean;
  browserHtml: boolean;
  approvalMode: "ask" | "smart" | "auto";
  newapiBaseUrl: string;
  newapiAdminConfigured: boolean;
  newapiAdminUserId: string;
  telegramConfigured: boolean;
  telegramChatId: string;
  timezone: string;
  origins: string[];
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
  { id: "appearance", label: "外观", icon: Palette },
  { id: "notify", label: "通知", icon: Bell },
  { id: "newapi", label: "new-api 与用量", icon: KeyRound },
  { id: "security", label: "安全", icon: Shield },
  { id: "system", label: "系统", icon: Server },
];

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
  const current = SECTIONS.find((x) => x.id === picked) ?? SECTIONS[0]!;
  const go = (id: string) => setParams({ s: id }, { replace: !!picked });

  const body = (
    <div className="space-y-8">
      {current.id === "general" && <GeneralSection s={s} save={save} />}
      {current.id === "appearance" && <AppearanceSection />}
      {current.id === "notify" && <NotifySection s={s} save={save} />}
      {current.id === "newapi" && <NewApiSection s={s} save={save} />}
      {current.id === "security" && <SecuritySection me={me.data} />}
      {current.id === "system" && <SystemSection />}
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
            <div className="px-2 pb-8 space-y-4">
              <nav className="space-y-px">
                {SECTIONS.map((x) => (
                  <button key={x.id} onClick={() => go(x.id)} className="w-full flex items-center gap-3 h-10 px-2.5 rounded-md text-left hover:bg-surface-2 active:bg-surface-2">
                    <x.icon className="size-4 text-muted" strokeWidth={1.8} />
                    <span className="flex-1">{x.label}</span>
                    <ChevronRight className="size-4 text-muted" />
                  </button>
                ))}
              </nav>
              <div className="h-px bg-[var(--border)] mx-2.5" />
              <nav className="space-y-px">
                <button onClick={() => nav("/usage")} className="w-full flex items-center gap-3 h-10 px-2.5 rounded-md text-left hover:bg-surface-2">
                  <Gauge className="size-4 text-muted" strokeWidth={1.8} />
                  <span className="flex-1">用量统计</span>
                  <ChevronRight className="size-4 text-muted" />
                </button>
                <button onClick={() => nav("/reflect")} className="w-full flex items-center gap-3 h-10 px-2.5 rounded-md text-left hover:bg-surface-2">
                  <Sparkles className="size-4 text-muted" strokeWidth={1.8} />
                  <span className="flex-1">回顾</span>
                  <ChevronRight className="size-4 text-muted" />
                </button>
                <button onClick={() => logout(qc)} className="w-full flex items-center gap-3 h-10 px-2.5 rounded-md text-left text-danger hover:bg-surface-2">
                  <LogOut className="size-4" strokeWidth={1.8} />
                  退出登录
                </button>
              </nav>
            </div>
          </>
        )}
      </div>

      {/* Desktop: Claude Code-style two-pane settings. */}
      <div className="hidden lg:flex gap-8 pt-6 pb-10">
        <nav className="w-48 shrink-0 space-y-px sticky top-6 self-start">
          <div className="px-2.5 pb-1.5 text-xs text-muted">设置</div>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              onClick={() => go(x.id)}
              className={cx(navItemClass(x.id === current.id), "w-full h-8 text-left text-[13.5px]")}
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
        <SettingRow title="中断后自动继续" desc="任务被重启、Codex 崩溃、网络或限流等临时故障打断，或单轮跑满 2 小时时，等一会儿自动在原对话里接着做。连续自动继续 3 次仍被打断就停下，不会无限重试。">
          <Toggle checked={s.autoResume} onChange={(v) => void save({ autoResume: v }, v ? "已开启自动继续" : "已关闭自动继续")} label="中断后自动继续" />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="浏览器">
        <SettingRow title="直接读取网页 HTML" desc="agent 用浏览器查信息时优先直接读页面 HTML，正文、表格、价格、链接比看截图更快更准；要看布局、图片或验证码时照样截图。对新对话生效。">
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
      <SettingGroup title="模型">
        <SettingRow wide title="新 agent 默认模型" desc="新建 agent 时预选的模型，之后每个 agent、每个对话都能单独改。">
          <div className="w-60">
            <ModelSelect value={s.defaultModel} onChange={(v) => void save({ defaultModel: v })} />
          </div>
        </SettingRow>
        <SettingRow wide title="复盘 / 整理用的模型" desc="任务结束后总结经验、生成回顾用它，建议选便宜、稳定的模型。">
          <div className="w-60">
            <ModelSelect value={s.reflectModel} onChange={(v) => void save({ reflectModel: v })} />
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
      <SettingGroup title="备用渠道">
        <SettingRow title="Telegram" desc={s.telegramConfigured ? `已配置 · chat ${s.telegramChatId}` : "可选：推送失败或紧急提醒时同时发 Telegram。"}>
          <Button size="sm" variant="soft" onClick={() => setTg(true)}>
            {s.telegramConfigured ? "修改" : "设置"}
          </Button>
        </SettingRow>
      </SettingGroup>
      <Sheet open={tg} onClose={() => setTg(false)} title="Telegram 备用通知">
        <div className="space-y-3.5">
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

function NewApiSection({ s, save }: { s: SettingsView; save: Save }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState(s.newapiAdminUserId);
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: () =>
      api.get<{ rows: { agent_id: string; day: string; model: string; runs: number; input_tokens: number; output_tokens: number }[]; spendUsd: Record<string, number> | null }>(
        "/api/usage?days=7",
      ),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const totals = new Map<string, { runs: number; tokens: number }>();
  for (const r of usage.data?.rows ?? []) {
    const t = totals.get(r.agent_id) ?? { runs: 0, tokens: 0 };
    t.runs += r.runs;
    t.tokens += r.input_tokens + r.output_tokens;
    totals.set(r.agent_id, t);
  }
  return (
    <>
      <SettingGroup title="new-api">
        <SettingRow title="网关地址" desc={<span className="font-mono">{s.newapiBaseUrl}</span>}>
          <Badge tone="ok">已连接</Badge>
        </SettingRow>
        <SettingRow title="管理令牌" desc="用于为每个 agent 生成专属令牌、统计费用和预算。">
          <Button size="sm" variant="soft" onClick={() => setOpen(true)}>
            {s.newapiAdminConfigured ? "修改" : "设置"}
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="近 7 天用量">
        <table className="w-full text-[13px]">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="text-left font-medium py-2">agent</th>
              <th className="text-right font-medium py-2">任务</th>
              <th className="text-right font-medium py-2">tokens</th>
              {usage.data?.spendUsd && <th className="text-right font-medium py-2">费用</th>}
            </tr>
          </thead>
          <tbody>
            {[...totals.entries()].map(([id, t]) => {
              const a = agents.data?.find((x) => x.id === id);
              return (
                <tr key={id} className="border-b border-line last:border-0">
                  <td className="py-2.5 truncate max-w-48">
                    {a?.emoji} {a?.name ?? "已删除"}
                  </td>
                  <td className="text-right tabular-nums">{t.runs}</td>
                  <td className="text-right tabular-nums">{tokens(t.tokens)}</td>
                  {usage.data?.spendUsd && <td className="text-right tabular-nums">${(usage.data.spendUsd[id] ?? 0).toFixed(2)}</td>}
                </tr>
              );
            })}
            {totals.size === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted text-center">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </SettingGroup>
      <Sheet open={open} onClose={() => setOpen(false)} title="new-api 管理令牌">
        <div className="space-y-3.5">
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
                setOpen(false);
                setToken("");
              })
            }
          >
            保存
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function SecuritySection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [totp, setTotp] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState<{ current: string; next: string } | null>(null);
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
          <SettingRow key={p.id} title={<span className="font-normal pl-4">{p.name}</span>} desc={<span className="pl-4">{`${p.rp_id} · ${p.last_used_at ? `上次使用 ${timeAgo(p.last_used_at)}` : "未使用"}`}</span>}>
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
      <Sheet open={!!totp} onClose={() => setTotp(null)} title="开启两步验证">
        {totp && (
          <div className="space-y-3.5">
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
          <div className="space-y-3.5">
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

function SystemSection() {
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
  return (
    <>
      <SettingGroup title={`系统 · v${d.version}`}>
        <SettingRow title="new-api" desc={d.newapi.ok ? `${d.newapi.models} 个模型可用` : d.newapi.error}>
          <Badge tone={d.newapi.ok ? "ok" : "danger"}>{d.newapi.ok ? "正常" : "异常"}</Badge>
        </SettingRow>
        <SettingRow title="磁盘与数据库" desc={`剩余 ${d.disk.freeGb} / ${d.disk.totalGb} GB · 数据库 ${d.dbSizeMb} MB`} />
        <SettingRow title="备份" desc={d.backups[0] ? `最近：${d.backups[0].name}（${(d.backups[0].size / 1e6).toFixed(1)} MB），保留 7 份` : "还没有备份（每天 03:30 自动备份）"}>
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
      </SettingGroup>
      <SettingGroup title="容器">
        {d.containers.map((c) => (
          <SettingRow key={c.name} title={<span className="font-mono text-[12.5px] font-normal">{c.name}</span>} desc={c.status}>
            <Badge tone={c.state === "running" ? "ok" : "muted"}>{c.role}</Badge>
          </SettingRow>
        ))}
      </SettingGroup>
    </>
  );
}
