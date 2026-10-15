import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bot, Brain, ClipboardPaste, History, Lightbulb, Loader2, Trash2, Undo2, UserRound } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { MemoryImport } from "../components/MemoryImport";
import { Button, Empty, Header, HeaderButton, Loading, Sheet, cx, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Agent, LearningEvent } from "../lib/types";

interface Knowledge {
  memory: { agent: string; user: string };
  skills: { name: string; description: string; scope: "agent" | "shared"; uses: number; updatedAt: string }[];
}

const items = (md: string) =>
  md
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);

export default function Learning() {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const [picked, setPicked] = useState<string>("");
  const agent = agents.data?.find((a) => a.id === picked) ?? agents.data?.[0];
  const agentId = agent?.id ?? "";
  const knowledge = useQuery({ queryKey: ["knowledge", agentId], queryFn: () => api.get<Knowledge>(`/api/agents/${agentId}/knowledge`), enabled: !!agentId });
  const list = useQuery({
    queryKey: ["learning", agentId],
    queryFn: () => api.get<LearningEvent[]>(`/api/learning?agentId=${agentId}&limit=30`),
    enabled: !!agentId,
  });
  const [open, setOpen] = useState<LearningEvent | null>(null);
  const diff = useQuery({ queryKey: ["learning", "diff", open?.id], queryFn: () => api.get<{ diff: string }>(`/api/learning/${open!.id}/diff`), enabled: !!open });
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [importing, setImporting] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["learning"] });
    void qc.invalidateQueries({ queryKey: ["knowledge"] });
  };

  const revert = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await api.post(`/api/learning/${open.id}/revert`);
      toast("已撤销");
      setOpen(null);
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    const t = text.trim();
    if (!t || !agentId) return;
    setAsking(true);
    try {
      const r = await api.post<{ reply: string; events: LearningEvent[] }>(`/api/agents/${agentId}/memory/instruct`, { text: t });
      toast(r.reply, r.events.length ? "ok" : "danger");
      if (r.events.length) setText("");
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setAsking(false);
    }
  };

  const remove = async (scope: "agent" | "user", item: string) => {
    try {
      const r = await api.post<{ events: LearningEvent[] }>(`/api/agents/${agentId}/memory/delete`, { scope, item });
      toast(r.events.length ? "已删除，可以在下方改动记录里撤销" : "没找到这条记忆", r.events.length ? "ok" : "danger");
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };

  const k = knowledge.data;
  const user = k ? items(k.memory.user) : [];
  const mine = k ? items(k.memory.agent) : [];
  return (
    <div className="min-h-[calc(100dvh-5rem)] lg:min-h-dvh flex flex-col lg:max-w-3xl">
      <Header
        title="学习"
        sub="agent 记下的记忆和技能，每一次改动都可以撤销"
        right={
          agent && <HeaderButton wide icon={<ClipboardPaste />} label="导入记忆" onClick={() => setImporting(true)} />
        }
      />
      <div className="flex-1 px-4 pb-4 space-y-8">
        <div className="flex gap-1 overflow-x-auto no-scrollbar -mx-4 px-4">
          {agents.data?.map((a) => (
            <Chip key={a.id} active={agentId === a.id} onClick={() => setPicked(a.id)}>
              {a.emoji} {a.name}
            </Chip>
          ))}
        </div>

        {!k ? (
          <Loading />
        ) : (
          <>
            <MemoryGroup icon={<UserRound />} title="关于你" hint="所有 agent 共享" list={user} onDelete={(i) => void remove("user", i)} />
            <MemoryGroup icon={<Bot />} title={`${agent!.name} 的记忆`} hint="这个 agent 自己的工作经验" list={mine} onDelete={(i) => void remove("agent", i)} />
            <Block icon={<Lightbulb />} title="技能" count={k.skills.length}>
              {k.skills.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-3.5 py-3 text-[13px] text-muted">还没有技能。完成有一定难度的多步任务后，agent 会把做法整理成技能。</div>
              ) : (
                <div className="space-y-2">
                  {k.skills.map((s) => (
                    <div key={`${s.scope}:${s.name}`} className="rounded-lg border border-line bg-surface px-3.5 py-2.5 flex items-baseline gap-4">
                      <span className="w-44 shrink-0 font-mono text-[12.5px] truncate">{s.name}</span>
                      <span className="flex-1 min-w-0 text-[13px] text-muted truncate">{s.description}</span>
                      <span className="shrink-0 text-xs text-muted whitespace-nowrap">
                        {s.scope === "shared" ? "共享 · " : ""}用过 {s.uses} 次
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Block>
          </>
        )}

        <Block icon={<History />} title="最近的改动" hint="点开可以查看和撤销">
          {list.isLoading ? (
            <Loading />
          ) : !list.data?.length ? (
            <Empty icon={<Brain className="size-6" />} title="还没有学到东西" hint="agent 完成多步任务、或你点了 👍 / 👎 之后，会自动复盘并记录经验" />
          ) : (
            <div className="space-y-2">
              {list.data.map((e) => (
                <button key={e.id} onClick={() => setOpen(e)} className={cx("w-full flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] hover:bg-surface-2", !!e.reverted && "opacity-55")}>
                  {e.kind === "skill" ? <Lightbulb className="size-4 mt-0.5 text-muted shrink-0" /> : <Brain className="size-4 mt-0.5 text-muted shrink-0" />}
                  <span className="flex-1 min-w-0 text-[13.5px] leading-snug line-clamp-2">{e.summary}</span>
                  <span className="shrink-0 text-xs text-muted whitespace-nowrap">
                    {e.reverted ? "已撤销 · " : e.scope === "shared" ? "共享 · " : ""}
                    {timeAgo(e.created_at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Block>
      </div>

      {agent && (
        <div className="sticky bottom-[calc(2.75rem+env(safe-area-inset-bottom))] lg:bottom-0 px-4 pb-3 pt-2 bg-app lg:max-w-3xl">
          <div className="flex items-end gap-1 rounded-2xl border border-line bg-surface p-1.5 pl-3 focus-within:border-[color-mix(in_oklab,var(--text)_30%,transparent)]">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  void ask();
                }
              }}
              rows={1}
              placeholder={`告诉${agent.name}要怎么改记忆，比如「记住我习惯用 pnpm」`}
              className="flex-1 min-w-0 resize-none max-h-32 min-h-8 bg-transparent py-1.5 text-sm outline-none field-sizing-content placeholder:text-muted"
            />
            <button
              aria-label="发送"
              onClick={ask}
              disabled={!text.trim() || asking}
              className={cx("size-7 mb-0.5 grid place-items-center rounded-lg shrink-0 transition-colors", text.trim() || asking ? "bg-accent text-white" : "bg-surface-2 text-muted")}
            >
              {asking ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      )}

      {agent && <MemoryImport open={importing} onClose={() => setImporting(false)} agentId={agent.id} agentName={agent.name} />}

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.kind === "skill" ? "技能变更" : "记忆变更"}>
        {open && (
          <div className="space-y-3.5">
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
                <Undo2 className="size-4" /> 撤销这次改动
              </Button>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** Page section: icon + title + count above its items, so groups read apart at a glance. */
function Block({ icon, title, hint, count, children }: { icon: React.ReactNode; title: string; hint?: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="size-6 grid place-items-center rounded-md bg-surface-2 text-muted shrink-0 [&>svg]:size-3.5">{icon}</span>
        <h2 className="font-display text-base font-semibold truncate">{title}</h2>
        {count !== undefined && <span className="text-xs text-muted tabular-nums">{count}</span>}
        {hint && <span className="ml-auto text-xs text-muted truncate">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** Claude-style memory list: one row per item, delete on hover. */
function MemoryGroup({ icon, title, hint, list, onDelete }: { icon: React.ReactNode; title: string; hint: string; list: string[]; onDelete: (item: string) => void }) {
  return (
    <Block icon={icon} title={title} hint={hint} count={list.length}>
      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-3.5 py-3 text-[13px] text-muted">还没有记忆。可以在下面直接告诉它要记住什么。</div>
      ) : (
        <div className="space-y-2">
          {list.map((i) => (
            <div key={i} className="group flex items-start gap-3 rounded-lg border border-line bg-surface px-3.5 py-2.5 transition-colors hover:bg-surface-2">
              <span className="flex-1 min-w-0 text-[13.5px] leading-relaxed">{i}</span>
              <button aria-label="删除这条记忆" title="删除" onClick={() => onDelete(i)} className="shrink-0 p-1 -m-0.5 rounded text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger [@media(pointer:coarse)]:opacity-100">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Block>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("px-2.5 h-7 rounded-md text-[13px] shrink-0 transition-colors", active ? "bg-[color-mix(in_oklab,var(--text)_9%,transparent)] font-medium" : "text-muted hover:bg-surface-2 hover:text-[var(--text)]")}>
      {children}
    </button>
  );
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |@@)/.test(l));
  return (
    <pre className="text-xs font-mono bg-surface-2 rounded-lg p-3 overflow-x-auto max-h-[50dvh]">
      {lines.map((l, i) => (
        <div key={i} className={cx(l.startsWith("+") && "text-ok", l.startsWith("-") && "text-danger", "whitespace-pre-wrap break-all")}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
