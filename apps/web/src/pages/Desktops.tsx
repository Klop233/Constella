import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, Empty, Field, Header, IconButton, Loading, Sheet, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Agent, Desktop } from "../lib/types";

export function leaseText(d: Desktop, agents: Agent[] | undefined): { text: string; tone: "ok" | "warn" | "accent" | "muted" } {
  const l = d.leaseInfo;
  if (l.holder === "human") return { text: "你在操作", tone: "warn" };
  if (l.holder === "agent") {
    const a = agents?.find((x) => x.id === l.agentId);
    return { text: `${a ? `${a.emoji} ${a.name}` : "agent"} 使用中`, tone: "accent" };
  }
  return d.state === "running" ? { text: "空闲", tone: "ok" } : { text: "已停止", tone: "muted" };
}

export default function Desktops() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["desktops"], queryFn: () => api.get<Desktop[]>("/api/desktops"), refetchInterval: 20_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const tick = Math.floor(Date.now() / 15000);

  const create = async () => {
    setBusy(true);
    try {
      const d = await api.post<Desktop>("/api/desktops", { name: name || "我的桌面" });
      setCreating(false);
      setName("");
      void qc.invalidateQueries({ queryKey: ["desktops"] });
      nav(`/desktops/${d.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Header
        title="桌面"
        sub="agent 的图形桌面，随时查看和接管"
        right={
          <IconButton label="新建桌面" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
          </IconButton>
        }
      />
      <div className="px-4 pb-6">
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Card>
            <Empty
              icon={<Monitor className="size-10" />}
              title="还没有桌面"
              hint="设置为「按需借用」的 agent 需要时会自动创建；也可以先建一台固定给某个 agent 用"
              action={<Button variant="primary" onClick={() => setCreating(true)}>新建桌面</Button>}
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {list.data.map((d) => {
              const l = leaseText(d, agents.data);
              return (
                <Card key={d.id} className="overflow-hidden" onClick={() => nav(`/desktops/${d.id}`)}>
                  <div className="aspect-[16/10] bg-surface-2 grid place-items-center">
                    {d.state === "running" ? (
                      <img src={`/api/desktops/${d.id}/screenshot?width=640&t=${tick}`} alt={d.name} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <Monitor className="size-10 text-muted" />
                    )}
                  </div>
                  <div className="px-4 py-3 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{d.name}</div>
                      <div className="text-xs text-muted">最近使用 {timeAgo(d.last_used_at)}</div>
                    </div>
                    <Badge tone={l.tone}>{l.text}</Badge>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      <Sheet open={creating} onClose={() => setCreating(false)} title="新建桌面">
        <div className="space-y-4">
          <Field label="名字" hint="每台桌面约占 0.4–1.5 GB 内存（打开浏览器时更多），闲置 30 分钟自动停止">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="我的桌面" maxLength={40} />
          </Field>
          <Button variant="primary" className="w-full" loading={busy} onClick={create}>
            创建
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
