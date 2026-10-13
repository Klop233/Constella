import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Database, Fingerprint, KeyRound, LogOut, Server, Shield, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { ModelSelect } from "./AgentEdit";
import { Badge, Button, Card, Field, Header, Loading, Row, Section, Sheet, Toggle, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo, tokens } from "../lib/format";
import { currentSubscription, disablePush, enablePush, pushSupported } from "../lib/push";
import type { Agent } from "../lib/types";

interface SettingsView {
  defaultModel: string;
  reflectModel: string;
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

export default function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsView>("/api/settings") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
  const save = async (patch: Record<string, string>, ok = "已保存") => {
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
  return (
    <div>
      <Header title="设置" sub={`你好，${me.data.name}`} />
      <div className="px-4 space-y-6 pb-8 lg:max-w-3xl">
        <PushSection />
        <Section title="模型">
          <Card className="p-4 space-y-4">
            <Field label="新 agent 默认模型">
              <ModelSelect value={s.defaultModel} onChange={(v) => save({ defaultModel: v })} />
            </Field>
            <Field label="复盘 / 整理用的模型" hint="每次任务结束后用它总结经验，建议选便宜、稳定的模型">
              <ModelSelect value={s.reflectModel} onChange={(v) => save({ reflectModel: v })} />
            </Field>
          </Card>
        </Section>
        <NewApiSection s={s} save={save} />
        <TelegramSection s={s} save={save} />
        <SecuritySection me={me.data} />
        <SystemSection />
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => void api.post("/api/auth/logout").then(() => qc.invalidateQueries())}
        >
          <LogOut className="size-4" /> 退出登录
        </Button>
      </div>
    </div>
  );
}

function PushSection() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const devices = useQuery({ queryKey: ["push-devices"], queryFn: () => api.get<{ endpoint: string; device: string; created_at: string }[]>("/api/push/devices") });
  useEffect(() => {
    void currentSubscription().then((s) => setOn(!!s));
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
    <Section title="通知">
      <Card className="divide-y divide-[var(--border)] overflow-hidden">
        <Row
          icon={<Bell className="size-5 text-muted" />}
          title="这台设备接收推送"
          sub={pushSupported() ? "审批请求、任务完成、提醒都会推送到这里" : "当前浏览器不支持；请用 Chrome 打开并添加到主屏幕"}
          right={on === null ? null : <Toggle checked={on} onChange={(v) => !busy && void toggle(v)} label="接收推送" />}
        />
        <Row
          icon={<Smartphone className="size-5 text-muted" />}
          title={`已登记设备 · ${devices.data?.length ?? 0}`}
          right={
            <button
              className="text-sm text-accent"
              onClick={() => void api.post<{ push: number }>("/api/push/test").then((r) => toast(r.push ? `已发送到 ${r.push} 台设备` : "没有可用的推送设备", r.push ? "ok" : "danger"))}
            >
              发送测试
            </button>
          }
        />
      </Card>
    </Section>
  );
}

function NewApiSection({ s, save }: { s: SettingsView; save: (p: Record<string, string>, ok?: string) => Promise<void> }) {
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
    <Section title="new-api 与用量（近 7 天）">
      <Card className="overflow-hidden">
        <Row icon={<Server className="size-5 text-muted" />} title="网关地址" sub={s.newapiBaseUrl} right={<Badge tone="ok">已连接</Badge>} />
        <div className="border-t border-line">
          <Row
            icon={<KeyRound className="size-5 text-muted" />}
            title="管理令牌"
            sub="用于为每个 agent 生成专属令牌、统计费用和预算"
            right={<button className="text-sm text-accent" onClick={() => setOpen(true)}>{s.newapiAdminConfigured ? "修改" : "设置"}</button>}
          />
        </div>
        <table className="w-full text-sm border-t border-line">
          <thead className="text-xs text-muted">
            <tr>
              <th className="text-left font-normal px-4 py-2">agent</th>
              <th className="text-right font-normal px-2 py-2">任务</th>
              <th className="text-right font-normal px-2 py-2">tokens</th>
              {usage.data?.spendUsd && <th className="text-right font-normal px-4 py-2">费用</th>}
            </tr>
          </thead>
          <tbody>
            {[...totals.entries()].map(([id, t]) => {
              const a = agents.data?.find((x) => x.id === id);
              return (
                <tr key={id} className="border-t border-line">
                  <td className="px-4 py-2 truncate max-w-36">
                    {a?.emoji} {a?.name ?? "已删除"}
                  </td>
                  <td className="text-right px-2 tabular-nums">{t.runs}</td>
                  <td className="text-right px-2 tabular-nums">{tokens(t.tokens)}</td>
                  {usage.data?.spendUsd && <td className="text-right px-4 tabular-nums">${(usage.data.spendUsd[id] ?? 0).toFixed(2)}</td>}
                </tr>
              );
            })}
            {totals.size === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-3 text-muted text-center">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="new-api 管理令牌">
        <div className="space-y-4">
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
    </Section>
  );
}

function TelegramSection({ s, save }: { s: SettingsView; save: (p: Record<string, string>, ok?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(s.telegramChatId);
  return (
    <Section title="备用通知渠道">
      <Card>
        <Row
          title="Telegram"
          sub={s.telegramConfigured ? `已配置 · chat ${s.telegramChatId}` : "可选：推送失败或紧急提醒时同时发 Telegram"}
          right={<button className="text-sm text-accent" onClick={() => setOpen(true)}>{s.telegramConfigured ? "修改" : "设置"}</button>}
        />
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="Telegram 备用通知">
        <div className="space-y-4">
          <Field label="Bot Token" hint="在 @BotFather 创建机器人获得。留空保存可清除">
            <input className={cx(inputClass, "font-mono")} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Chat ID" hint="先给机器人发一条消息，再用 @userinfobot 查自己的 ID">
            <input className={inputClass} value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </Field>
          <Button variant="primary" className="w-full" onClick={() => void save({ telegramBotToken: token, telegramChatId: chatId }).then(() => setOpen(false))}>
            保存
          </Button>
        </div>
      </Sheet>
    </Section>
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
    <Section title="安全">
      <Card className="divide-y divide-[var(--border)] overflow-hidden">
        <Row icon={<Fingerprint className="size-5 text-muted" />} title={`通行密钥 · ${me.passkeys.length}`} sub="用指纹 / 面容登录，比密码更安全" right={<button className="text-sm text-accent" onClick={addPasskey}>添加</button>} />
        {me.passkeys.map((p) => (
          <Row
            key={p.id}
            title={<span className="text-sm">{p.name}</span>}
            sub={`${p.rp_id} · ${p.last_used_at ? `上次使用 ${timeAgo(p.last_used_at)}` : "未使用"}`}
            right={
              <button className="text-sm text-danger" onClick={wrap(() => api.del(`/api/auth/passkeys/${encodeURIComponent(p.id)}`), "已删除")}>
                删除
              </button>
            }
          />
        ))}
        <Row
          icon={<Shield className="size-5 text-muted" />}
          title="两步验证（TOTP）"
          sub={me.totp ? "已开启：密码登录时需要验证码" : "未开启"}
          right={
            me.totp ? (
              <button
                className="text-sm text-danger"
                onClick={() => {
                  const password = prompt("输入密码以关闭两步验证");
                  if (password) void wrap(() => api.post("/api/auth/totp/disable", { password }), "已关闭")();
                }}
              >
                关闭
              </button>
            ) : (
              <button
                className="text-sm text-accent"
                onClick={async () => {
                  const t = await api.post<{ secret: string; uri: string }>("/api/auth/totp/begin");
                  setTotp({ ...t, qr: await QRCode.toDataURL(t.uri, { margin: 1, width: 220 }) });
                }}
              >
                开启
              </button>
            )
          }
        />
        <Row icon={<KeyRound className="size-5 text-muted" />} title="修改密码" onClick={() => setPw({ current: "", next: "" })} />
        {me.sessions.map((sess) => (
          <Row
            key={sess.id}
            icon={<Smartphone className="size-5 text-muted" />}
            title={
              <span className="text-sm">
                {sess.device} {sess.current && <Badge tone="ok">当前</Badge>}
              </span>
            }
            sub={`${sess.ip} · ${timeAgo(sess.last_seen_at)}`}
            right={
              !sess.current && (
                <button className="text-sm text-danger" onClick={wrap(() => api.del(`/api/auth/sessions/${sess.id}`), "已下线")}>
                  下线
                </button>
              )
            }
          />
        ))}
      </Card>
      <Sheet open={!!totp} onClose={() => setTotp(null)} title="开启两步验证">
        {totp && (
          <div className="space-y-4">
            <img src={totp.qr} alt="TOTP 二维码" className="mx-auto rounded-xl bg-white p-2" />
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
          <div className="space-y-4">
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
    </Section>
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
    <Section title={`系统 · v${d.version}`}>
      <Card className="divide-y divide-[var(--border)] overflow-hidden">
        <Row icon={<Server className="size-5 text-muted" />} title="new-api" sub={d.newapi.ok ? `${d.newapi.models} 个模型可用` : d.newapi.error} right={<Badge tone={d.newapi.ok ? "ok" : "danger"}>{d.newapi.ok ? "正常" : "异常"}</Badge>} />
        <Row icon={<Database className="size-5 text-muted" />} title="磁盘与数据库" sub={`剩余 ${d.disk.freeGb} / ${d.disk.totalGb} GB · 数据库 ${d.dbSizeMb} MB`} />
        {d.containers.map((c) => (
          <Row key={c.name} title={<span className="font-mono text-xs">{c.name}</span>} sub={c.status} right={<Badge tone={c.state === "running" ? "ok" : "muted"}>{c.role}</Badge>} />
        ))}
        <Row
          title="备份"
          sub={d.backups[0] ? `最近：${d.backups[0].name}（${(d.backups[0].size / 1e6).toFixed(1)} MB），保留 7 份` : "还没有备份（每天 03:30 自动备份）"}
          right={
            <button
              className="text-sm text-accent"
              disabled={busy}
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
            </button>
          }
        />
      </Card>
    </Section>
  );
}
