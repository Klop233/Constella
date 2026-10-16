import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AgentAvatar } from "../components/AgentBits";
import { Button, Card, Empty, Header, Loading, Section } from "../components/ui";
import { api } from "../lib/api";
import { draftKey, writeDraft } from "../lib/drafts";
import { clearShared, handOffFiles, readShared, type Shared } from "../lib/share";
import type { Overview } from "../lib/types";

/** Landing page of the system share sheet: pick the agent that gets the shared text and files. */
export default function Share() {
  const nav = useNavigate();
  const [shared, setShared] = useState<Shared | null | undefined>(undefined);
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview") });
  useEffect(() => {
    void readShared().then(setShared);
  }, []);

  const pick = async (agentId: string) => {
    if (!shared) return;
    writeDraft(draftKey(undefined, agentId), shared.text);
    handOffFiles(agentId, shared.files);
    await clearShared();
    nav(`/agents/${agentId}/chat`, { replace: true });
  };

  if (shared === undefined || overview.isLoading) return <Loading />;
  const agents = overview.data?.agents ?? [];
  return (
    <div className="lg:max-w-3xl">
      <Header title="分享给 agent" />
      <div className="px-4 space-y-8 pb-6">
        {!shared ? (
          <Card>
            <Empty title="没有收到内容" hint="在其他 App 里点「分享」，选 Constella。需要先把 Constella 添加到主屏幕。" />
          </Card>
        ) : (
          <>
            <Card className="p-3.5 space-y-2">
              {shared.text && <div className="text-sm whitespace-pre-wrap break-words line-clamp-6">{shared.text}</div>}
              {shared.files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px] text-muted">
                  <FileText className="size-4 shrink-0" />
                  <span className="truncate flex-1">{f.name}</span>
                  <span className="tabular-nums">{f.size >= 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1e3))} KB`}</span>
                </div>
              ))}
            </Card>
            <Section title="交给谁">
              {agents.length ? (
                <Card className="divide-y divide-[var(--border)] overflow-hidden">
                  {agents.map((a) => (
                    <button key={a.id} type="button" onClick={() => void pick(a.id)} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-surface-2 active:bg-surface-2">
                      <AgentAvatar emoji={a.emoji} size="sm" />
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="text-xs text-muted">新对话</span>
                    </button>
                  ))}
                </Card>
              ) : (
                <Card>
                  <Empty title="还没有 agent" action={<Button variant="primary" onClick={() => nav("/agents/new")}>新建 agent</Button>} />
                </Card>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
