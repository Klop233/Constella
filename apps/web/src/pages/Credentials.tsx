import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Lock, LockOpen, Plus, RefreshCw, Search, Shield, Trash2, Unlock, X } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { Badge, Button, Card, Empty, Field, Header, Loading, Section, Select, Sheet, Tabs, cx, inputClass, toast } from "../components/ui";

type Connection = { id: string; name: string; provider: "bitwarden"; server: string; status: "locked" | "unlocked" | "error"; error?: string };
type Item = { id: string; name: string; username?: string; uris: string[]; fields: string[] };
type Request = { id: string; connectionId: string; itemId: string; itemName: string; agentId: string; runId: string; fields: string[]; purpose: string; target: string; status: "pending" | "approved" | "denied" | "expired" | "consumed" | "revoked"; createdAt: string; expiresAt: string; decidedAt?: string; reason?: string; reviewerAgentId?: string };
type AccessLog = { id: string; action: string; agentId?: string; requestId?: string; createdAt: string };
type Agent = { id: string; name: string; emoji?: string };
type Data = { connections: Connection[]; approverAgentId: string | null; requests: Request[]; accessLog: AccessLog[] };

const statusLabel: Record<Connection["status"], string> = { locked: "已锁定", unlocked: "已解锁", error: "异常" };
const requestLabel: Record<Request["status"], string> = { pending: "待处理", approved: "已批准", denied: "已拒绝", expired: "已过期", consumed: "已使用", revoked: "已撤销" };
/** Field names agents ask for, in the words the owner uses. */
const fieldText: Record<string, string> = { "login.username": "用户名", "login.password": "密码", "login.totp": "验证码" };
const fieldsText = (fields: string[]) => fields.map((f) => fieldText[f] ?? f).join("、");
const actionLabel: Record<string, string> = {
  "connection.create": "添加连接",
  "connection.delete": "删除连接",
  settings: "修改审批 agent",
  unlock: "解锁密码库",
  "unlock.failed": "解锁失败",
  lock: "锁定密码库",
  sync: "同步密码库",
  request: "agent 申请访问",
  "review.started": "审批 agent 开始审核",
  approve: "批准访问",
  deny: "拒绝访问",
  revoke: "撤销访问",
  read: "读取凭据",
  "read.failed": "读取失败",
};
function tone(status: string): "muted" | "ok" | "warn" | "danger" | "accent" { if (["unlocked", "approved", "consumed"].includes(status)) return "ok"; if (["pending", "locked"].includes(status)) return "warn"; if (["error", "denied"].includes(status)) return "danger"; return "muted"; }
function ago(value: string) { const d = Date.parse(value); if (!Number.isFinite(d)) return value; const m = Math.floor((Date.now() - d) / 60000); return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : new Date(d).toLocaleDateString("zh-CN"); }

export default function Credentials() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["credentials"], queryFn: () => api.get<Data>("/api/credentials") });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const [tab, setTab] = useState<"connections" | "requests" | "history">("connections");
  const [add, setAdd] = useState(false);
  const [unlock, setUnlock] = useState<Connection | null>(null);
  const [items, setItems] = useState<{ connection: Connection; values: Item[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data.data) return <Loading />;
  const d = data.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["credentials"] });
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => { setBusy(key); try { await fn(); toast(ok); refresh(); } catch (e) { toast(e instanceof Error ? e.message : String(e), "danger"); } finally { setBusy(null); } };
  const saveApprover = (approverAgentId: string | null) => act("approver", () => api.put("/api/credentials/settings", { approverAgentId }), "审批 agent 已保存");
  return <div className="pb-8"><Header title="凭据与隐私" sub="Bitwarden 连接与访问审批" />
    <div className="px-4 space-y-5">
      <Card className="p-3.5 space-y-2"><div className="flex items-center gap-2"><Shield className="size-4 text-accent" /><div className="font-medium">安全边界</div></div><p className="text-xs text-muted leading-relaxed">主密码只在解锁时提交给服务器，不保存也不显示；连接信息加密存放。批准记录和访问历史里只有条目名、字段名和用途，没有密码本身。</p><p className="text-xs text-muted leading-relaxed">批准后，被申请的字段值会交给申请它的 agent，进入那次对话和模型上下文，也可能留在它自己的会话记录里。锁定、撤销和任务结束只能阻止之后的读取，收不回已经交出去的值。</p></Card>
      <Section title="审批 agent"><div className="flex items-center gap-2"><Select label="审批 agent" className="flex-1 min-w-0" value={d.approverAgentId ?? ""} onChange={(v) => void saveApprover(v || null)} options={[{ value: "", label: "不指定（手动审批）" }, ...(agents.data ?? []).map(a => ({ value: a.id, label: `${a.emoji ? `${a.emoji} ` : ""}${a.name}` }))]} /><Badge tone={d.approverAgentId ? "accent" : "muted"}>{d.approverAgentId ? "已指定" : "手动"}</Badge></div></Section>
      <Tabs value={tab} options={[{ value: "connections", label: `连接 (${d.connections.length})` }, { value: "requests", label: `访问请求 (${d.requests.filter(r => r.status === "pending").length})` }, { value: "history", label: "访问历史" }]} onChange={setTab} />
      {tab === "connections" && <Connections data={d.connections} onAdd={() => setAdd(true)} onUnlock={setUnlock} onItems={setItems} act={act} busy={busy} />}
      {tab === "requests" && <Requests requests={d.requests} agents={agents.data ?? []} act={act} busy={busy} />}
      {tab === "history" && <History entries={d.accessLog} />}
    </div>
    <AddSheet open={add} onClose={() => setAdd(false)} onSaved={refresh} />
    <UnlockSheet connection={unlock} onClose={() => setUnlock(null)} onSaved={refresh} />
    <ItemsSheet state={items} onClose={() => setItems(null)} />
  </div>;
}

function Connections({ data, onAdd, onUnlock, onItems, act, busy }: { data: Connection[]; onAdd: () => void; onUnlock: (c: Connection) => void; onItems: (s: { connection: Connection; values: Item[] }) => void; act: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: string | null }) {
 return <Section title="Bitwarden 连接" action={<Button size="sm" variant="secondary" onClick={onAdd}><Plus className="size-3.5" />添加连接</Button>}><div className="divide-y divide-line border border-line rounded-xl bg-surface">{data.length === 0 ? <Empty icon={<KeyRound className="size-6" />} title="还没有 Bitwarden 连接" hint="添加连接后，agent 才能申请访问凭据。" action={<Button size="sm" onClick={onAdd}>添加连接</Button>} /> : data.map(c => <div key={c.id} className="p-3.5 space-y-2.5"><div className="flex items-start gap-2"><KeyRound className="size-4 mt-0.5 text-muted" /><div className="min-w-0 flex-1"><div className="font-medium truncate">{c.name}</div><div className="text-xs text-muted">Bitwarden · {serverText(c.server)}</div></div><Badge tone={tone(c.status)}>{c.status === "unlocked" ? <LockOpen className="size-3" /> : <Lock className="size-3" />}{statusLabel[c.status]}</Badge></div>{c.error && <div className="text-xs text-danger">{c.error}</div>}<div className="flex gap-1.5 justify-end">{c.status === "unlocked" ? <><Button size="sm" variant="soft" loading={busy === `sync-${c.id}`} onClick={() => void act(`sync-${c.id}`, () => api.post(`/api/credentials/connections/${c.id}/sync`), "已同步密码库")}><RefreshCw className="size-3.5" />同步</Button><Button size="sm" variant="soft" onClick={() => onItems({ connection: c, values: [] })}>查看项目</Button><Button size="sm" variant="secondary" onClick={() => void act(`lock-${c.id}`, () => api.post(`/api/credentials/connections/${c.id}/lock`), "连接已锁定")}><Lock className="size-3.5" />锁定</Button></> : <Button size="sm" onClick={() => onUnlock(c)}><Unlock className="size-3.5" />解锁</Button>}<Button size="sm" variant="ghost" className="text-danger" aria-label={`删除连接 ${c.name}`} onClick={() => { if (confirm(`确定删除“${c.name}”吗？`)) void act(`delete-${c.id}`, () => api.del(`/api/credentials/connections/${c.id}`), "连接已删除"); }}><Trash2 className="size-3.5" /></Button></div></div>)}</div></Section>;
}

function Requests({ requests, agents, act, busy }: { requests: Request[]; agents: Agent[]; act: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: string | null }) {
  const name = (id: string) => agents.find(a => a.id === id)?.name ?? id.slice(0, 8);
  return <Section title="访问请求"><div className="divide-y divide-line border border-line rounded-xl bg-surface">
    {requests.length === 0 ? <Empty title="暂无访问请求" hint="agent 申请凭据时会显示在这里，由指定的审批 agent 或你本人处理。" /> : requests.map(r => <div key={r.id} className="p-3.5 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{r.itemName}</div>
          <div className="text-xs text-muted">{name(r.agentId)} · {r.target} · {ago(r.createdAt)}</div>
        </div>
        <Badge tone={tone(r.status)}>{requestLabel[r.status]}</Badge>
      </div>
      <div className="text-xs text-muted">申请字段：{fieldsText(r.fields) || "未指定"}{r.reviewerAgentId ? ` · 审批：${name(r.reviewerAgentId)}` : " · 未指定审批 agent"}</div>
      <div className="text-xs">用途：{r.purpose}</div>
      {r.reason && <div className="text-xs text-muted">决定理由：{r.reason}</div>}
      {r.status === "approved" && <div className="text-xs text-muted">10 分钟内可读取一次，用掉或过期后需要重新申请。</div>}
      {r.status === "pending" && <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="secondary" loading={busy === `deny-${r.id}`} onClick={() => void act(`deny-${r.id}`, () => api.post(`/api/credentials/requests/${r.id}/decision`, { decision: "deny", reason: "手动拒绝" }), "已拒绝请求")}>拒绝</Button>
        <Button size="sm" variant="primary" loading={busy === `approve-${r.id}`} onClick={() => void act(`approve-${r.id}`, () => api.post(`/api/credentials/requests/${r.id}/decision`, { decision: "approve", reason: "手动批准" }), "已批准请求")}><Check className="size-3.5" />批准</Button>
      </div>}
      {["approved", "consumed"].includes(r.status) && <div className="flex justify-end"><Button size="sm" variant="ghost" className="text-danger" onClick={() => void act(`revoke-${r.id}`, () => api.post(`/api/credentials/requests/${r.id}/revoke`), "访问已撤销")}>撤销访问</Button></div>}
    </div>)}
  </div></Section>;
}
function History({ entries }: { entries: AccessLog[] }) { return <Section title="访问历史"><div className="border border-line rounded-xl bg-surface divide-y divide-line">{entries.length === 0 ? <Empty title="暂无访问记录" /> : entries.map(e => <div key={e.id} className="px-3.5 py-2.5 flex items-center gap-3"><div className="flex-1"><div className="text-[13px]">{actionLabel[e.action] ?? e.action}</div><div className="text-xs text-muted">{e.agentId ? `agent ${e.agentId.slice(0, 8)}` : "系统"}{e.requestId ? ` · 请求 ${e.requestId.slice(0, 8)}` : ""}</div></div><span className="text-xs text-muted tabular-nums">{ago(e.createdAt)}</span></div>)}</div></Section>; }

/** How a server reads in a list: the official regions, or the third-party address as given. */
const serverText = (server: string) => (server === "us" ? "Bitwarden（美国）" : server === "eu" ? "Bitwarden（欧洲）" : server);
/** Plain HTTP is only offered for a server on the owner's own network. */
const privateHost = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;
function serverOk(server: string) {
  if (server === "us" || server === "eu") return true;
  let url: URL;
  try { url = new URL(server); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && privateHost.test(url.hostname));
}

function AddSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("us");
  const [customUrl, setCustomUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [caCert, setCaCert] = useState("");
  const [showCa, setShowCa] = useState(false);
  const [loading, setLoading] = useState(false);
  const server = preset === "custom" ? customUrl.trim() : preset;
  const ready = !!name.trim() && !!clientId.trim() && !!clientSecret && serverOk(server);
  const submit = async () => {
    setLoading(true);
    try {
      await api.post("/api/credentials/connections", { name: name.trim(), provider: "bitwarden", server, clientId: clientId.trim(), clientSecret, ...(caCert.trim() ? { caCert: caCert.trim() } : {}) });
      toast("连接已添加，解锁后才能读取");
      onSaved(); onClose();
      setName(""); setClientId(""); setClientSecret(""); setCustomUrl(""); setCaCert(""); setShowCa(false);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "danger"); } finally { setLoading(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="添加 Bitwarden 连接">
      <div className="space-y-3">
        <Field label="名称"><input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="例如：团队密码库" /></Field>
        <Field label="服务器"><Select className="w-full" value={preset} onChange={setPreset} options={[{ value: "us", label: "Bitwarden（美国）" }, { value: "eu", label: "Bitwarden（欧洲）" }, { value: "custom", label: "第三方 / 自托管" }]} /></Field>
        {preset === "custom" && <Field label="服务器地址" hint="Vaultwarden 等 Bitwarden 兼容服务填完整地址。内网地址（192.168.x.x、*.local）可以用 http://，其余必须 https://。"><input className={inputClass} value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="https://vault.example.com" /></Field>}
        <Field label="Client ID" hint="Bitwarden 个人 API Key 的 client_id，在网页版的「安全 → 密钥」里生成；第三方服务在同一个位置。"><input className={inputClass} value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" /></Field>
        <Field label="Client Secret" hint="只发送到服务器，之后不再显示。"><input className={inputClass} type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="new-password" /></Field>
        {preset === "custom" && (showCa
          ? <Field label="服务器证书（可选）" hint="第三方服务器用自签名或私有 CA 时，把 PEM 证书贴在这里，只用于这个连接。"><textarea className={cx(inputClass, "h-24 font-mono text-[12px]")} value={caCert} onChange={e => setCaCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
          : <button type="button" onClick={() => setShowCa(true)} className="text-xs text-muted hover:text-[var(--text)]">服务器证书不受信任？添加自签名证书</button>)}
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={loading} disabled={!ready} onClick={() => void submit()}>保存连接</Button></div>
      </div>
    </Sheet>
  );
}
function UnlockSheet({ connection, onClose, onSaved }: { connection: Connection | null; onClose: () => void; onSaved: () => void }) { const [password, setPassword] = useState(""); const [loading, setLoading] = useState(false); const submit = async () => { if (!connection) return; setLoading(true); try { await api.post(`/api/credentials/connections/${connection.id}/unlock`, { password }); toast("连接已解锁"); onSaved(); onClose(); setPassword(""); } catch (e) { toast(e instanceof Error ? e.message : String(e), "danger"); } finally { setLoading(false); } }; return <Sheet open={!!connection} onClose={onClose} title={`解锁 ${connection?.name ?? "连接"}`}><div className="space-y-3"><p className="text-sm text-muted">主密码只用于本次解锁，关闭页面后不会保留。</p><Field label="Bitwarden 主密码"><input autoFocus type="password" className={inputClass} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e => e.key === "Enter" && void submit()} /></Field><div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={loading} disabled={!password} onClick={() => void submit()}>解锁</Button></div></div></Sheet>; }
function ItemsSheet({ state, onClose }: { state: { connection: Connection; values: Item[] } | null; onClose: () => void }) { const [search, setSearch] = useState(""); const q = useQuery({ queryKey: ["credential-items", state?.connection.id, search], queryFn: () => api.get<Item[]>(`/api/credentials/connections/${state!.connection.id}/items?search=${encodeURIComponent(search)}`), enabled: !!state }); const values = q.data ?? state?.values ?? []; return <Sheet open={!!state} onClose={onClose} title={`${state?.connection.name ?? ""} · 密码库项目`}><div className="space-y-3"><label className="flex items-center gap-2 border border-line rounded-lg px-2.5 h-8"><Search className="size-3.5 text-muted" /><input className="flex-1 bg-transparent outline-none text-[13px]" placeholder="搜索项目" value={search} onChange={e => setSearch(e.target.value)} /></label>{q.isLoading ? <Loading /> : values.length ? <div className="divide-y divide-line border border-line rounded-lg">{values.map(i => <div key={i.id} className="px-3 py-2"><div className="text-[13.5px] font-medium">{i.name}</div><div className="text-xs text-muted">{i.username ?? "无用户名"} · 可申请：{fieldsText(i.fields) || "无"}</div></div>)}</div> : <Empty title="没有匹配项目" hint="项目内容不会显示在这里，只展示名称和可申请字段。" />}</div></Sheet>; }
