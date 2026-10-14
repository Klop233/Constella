import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { InstanceFields, type InstanceDraft } from "../components/InstanceFields";
import { InstanceThumb } from "../components/InstanceThumb";
import { Badge, Button, Card, Empty, Header, IconButton, Loading, Sheet, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { KIND_INFO, leaseText } from "../lib/instances";
import type { Agent, Desktop, HostCaps } from "../lib/types";

const EMPTY: InstanceDraft = { name: "", kind: "browser", options: {}, agentIds: [] };

export default function Desktops() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["desktops"], queryFn: () => api.get<Desktop[]>("/api/desktops"), refetchInterval: 20_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const caps = useQuery({ queryKey: ["hostcaps"], queryFn: () => api.get<HostCaps>("/api/desktops/capabilities"), refetchInterval: (q) => (q.state.data?.checkedAt ? false : 3000) });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<InstanceDraft>(EMPTY);
  const [busy, setBusy] = useState(false);

  const open = () => {
    const firstOk = caps.data ? (["browser", "desktop", "android"] as const).find((k) => caps.data!.kinds[k].ok) : undefined;
    setDraft({ ...EMPTY, kind: firstOk ?? "browser" });
    setCreating(true);
  };

  const create = async () => {
    setBusy(true);
    try {
      const d = await api.post<Desktop>("/api/desktops", { name: draft.name.trim() || KIND_INFO[draft.kind].label, kind: draft.kind, options: draft.options, agentIds: draft.agentIds });
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ["desktops"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
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
        sub="浏览器、Linux 桌面和安卓实例，随时查看和接管"
        right={
          <IconButton label="新建实例" onClick={open}>
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
              title="还没有实例"
              hint="新建一个浏览器、Linux 桌面或安卓实例并分给 agent；agent 需要时也可以自己新建"
              action={
                <Button variant="primary" onClick={open}>
                  新建实例
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {list.data.map((d) => {
              const l = leaseText(d, agents.data);
              const Icon = KIND_INFO[d.kind].icon;
              const users = agents.data?.filter((a) => d.agentIds.includes(a.id)) ?? [];
              return (
                <Card key={d.id} className="overflow-hidden" onClick={() => nav(`/desktops/${d.id}`)}>
                  <InstanceThumb d={d} width={640} className="aspect-[16/10]" />
                  <div className="px-4 py-3 flex items-center gap-2">
                    <Icon className="size-4 text-muted shrink-0" aria-label={KIND_INFO[d.kind].label} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{d.name}</div>
                      <div className="text-xs text-muted truncate">
                        {KIND_INFO[d.kind].label} · {users.length ? users.map((a) => a.emoji).join("") : "没有分给 agent"} · {timeAgo(d.last_used_at)}
                      </div>
                    </div>
                    <Badge tone={l.tone}>{l.text}</Badge>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      <Sheet open={creating} onClose={() => setCreating(false)} title="新建实例">
        <div className="space-y-4">
          <InstanceFields draft={draft} onChange={setDraft} caps={caps.data} agents={agents.data} />
          <Button variant="primary" className="w-full" loading={busy} disabled={!!caps.data && !caps.data.kinds[draft.kind].ok} onClick={create}>
            创建
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
