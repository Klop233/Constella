import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Lightbulb, Undo2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge, Button, Card, Empty, Header, Loading, Sheet, cx, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Agent, LearningEvent } from "../lib/types";

export default function Learning() {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState<string>("");
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const list = useQuery({
    queryKey: ["learning", agentId],
    queryFn: () => api.get<LearningEvent[]>(`/api/learning${agentId ? `?agentId=${agentId}` : ""}`),
  });
  const [open, setOpen] = useState<LearningEvent | null>(null);
  const diff = useQuery({ queryKey: ["learning", "diff", open?.id], queryFn: () => api.get<{ diff: string }>(`/api/learning/${open!.id}/diff`), enabled: !!open });
  const [busy, setBusy] = useState(false);

  const revert = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await api.post(`/api/learning/${open.id}/revert`);
      toast("已撤销");
      setOpen(null);
      void qc.invalidateQueries({ queryKey: ["learning"] });
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Header title="学习" sub="agent 自己记下的经验和技能，每一条都可以撤销" />
      <div className="px-4 pb-6 space-y-4">
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4">
          <Chip active={!agentId} onClick={() => setAgentId("")}>
            全部
          </Chip>
          {agents.data?.map((a) => (
            <Chip key={a.id} active={agentId === a.id} onClick={() => setAgentId(a.id)}>
              {a.emoji} {a.name}
            </Chip>
          ))}
        </div>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <Card>
            <Empty icon={<Brain className="size-9" />} title="还没有学到东西" hint="agent 完成多步任务、或你点了👍/👎之后，会自动复盘并记录经验" />
          </Card>
        ) : (
          <div className="space-y-2.5">
            {list.data.map((e) => (
              <Card key={e.id} className={cx("p-3.5", !!e.reverted && "opacity-55")} onClick={() => setOpen(e)}>
                <div className="flex items-start gap-3">
                  <div className="size-9 rounded-xl grid place-items-center bg-accent-soft text-accent shrink-0">
                    {e.kind === "skill" ? <Lightbulb className="size-4.5" /> : <Brain className="size-4.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm leading-snug line-clamp-2">{e.summary}</div>
                    <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted flex-wrap">
                      {e.agent ? (
                        <span>
                          {e.agent.emoji} {e.agent.name}
                        </span>
                      ) : (
                        <span>共享</span>
                      )}
                      <span>· {timeAgo(e.created_at)}</span>
                      {e.scope === "shared" && <Badge tone="accent">共享</Badge>}
                      {e.reverted ? <Badge>已撤销</Badge> : null}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.kind === "skill" ? "技能变更" : "记忆变更"}>
        {open && (
          <div className="space-y-4">
            <div className="text-sm">{open.summary}</div>
            {open.run_id && (
              <div className="text-xs text-muted">
                来自一次任务复盘
                {open.agent && (
                  <>
                    {" · "}
                    <Link className="underline" to={`/agents/${open.agent_id}`} onClick={() => setOpen(null)}>
                      查看 agent
                    </Link>
                  </>
                )}
              </div>
            )}
            {diff.isLoading ? <Loading /> : <DiffView text={diff.data?.diff ?? ""} />}
            {!open.reverted && (
              <Button variant="danger" className="w-full" loading={busy} onClick={revert}>
                <Undo2 className="size-4" /> 撤销这次学习
              </Button>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("px-3 h-8 rounded-full text-sm shrink-0", active ? "bg-accent text-white" : "bg-surface border border-line")}>
      {children}
    </button>
  );
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |@@)/.test(l));
  return (
    <pre className="text-xs font-mono bg-surface-2 rounded-xl p-3 overflow-x-auto max-h-[50dvh]">
      {lines.map((l, i) => (
        <div key={i} className={cx(l.startsWith("+") && "text-ok", l.startsWith("-") && "text-danger", "whitespace-pre-wrap break-all")}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
