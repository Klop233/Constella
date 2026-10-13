import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ImagePlus, Loader2, Paperclip, Plus, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentDot } from "../components/AgentBits";
import { ContextMeter, EffortPicker, ModelPicker } from "../components/ChatControls";
import { latestStats, RunView } from "../components/RunView";
import { Header, Loading, cx, toast } from "../components/ui";
import { api, fileToBase64 } from "../lib/api";
import { useAppearance } from "../lib/appearance";
import { useAgentEvents } from "../lib/live";
import type { Agent, AgentEvent, Approval, Conversation, Effort, Run } from "../lib/types";

const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

interface ConvData {
  conversation: Conversation;
  runs: Run[];
  approvals: Approval[];
}

export default function Chat() {
  const { conversationId, id: newAgentId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [data, setData] = useState<ConvData | null>(null);
  const [loading, setLoading] = useState(!!conversationId);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; path: string; image: boolean }[]>([]);
  const [sending, setSending] = useState(false);
  // This conversation's model / effort; null follows the agent.
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [uploading, setUploading] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const agentId = data?.conversation.agent_id ?? newAgentId;
  const agent = useQuery({ queryKey: ["agent", agentId], queryFn: () => api.get<Agent>(`/api/agents/${agentId}`), enabled: !!agentId });

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      setData(await api.get<ConvData>(`/api/conversations/${conversationId}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setModel(data?.conversation.model ?? null);
    setEffort(data?.conversation.effort ?? null);
  }, [data?.conversation.id, data?.conversation.model, data?.conversation.effort]);

  const changeModel = async (patch: { model?: string | null; effort?: Effort | null }) => {
    if (patch.model !== undefined) setModel(patch.model);
    if (patch.effort !== undefined) setEffort(patch.effort);
    if (!conversationId) return; // a new conversation sends it with the first message
    try {
      await api.patch(`/api/conversations/${conversationId}`, patch);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };

  useEffect(() => {
    setData(null);
    setLoading(!!conversationId);
    stick.current = true;
    void load();
  }, [conversationId, load]);

  // Live events: append to the matching run; unknown runs or approvals trigger a reload.
  const onEvent = useCallback(
    (convId: string, ev: AgentEvent) => {
      if (convId !== conversationId) return;
      setData((cur) => {
        if (!cur) return cur;
        const idx = cur.runs.findIndex((r) => r.id === ev.runId);
        if (idx < 0) {
          void load();
          return cur;
        }
        const run = cur.runs[idx]!;
        const lastSeq = run.events.at(-1)?.seq ?? -1;
        if (ev.seq <= lastSeq) return cur;
        const next = { ...run, events: [...run.events, ev] };
        if (ev.type === "run.status") next.status = ev.status;
        if (ev.type === "run.status" && ev.error) next.error = ev.error;
        const runs = [...cur.runs];
        runs[idx] = next;
        return { ...cur, runs };
      });
      if (ev.type === "approval.requested" || ev.type === "approval.resolved" || (ev.type === "run.status" && ["done", "failed", "cancelled"].includes(ev.status))) {
        void load();
      }
    },
    [conversationId, load],
  );
  useAgentEvents(onEvent);

  useLayoutEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  });

  const { usage: showUsage } = useAppearance();
  const stats = showUsage && data ? latestStats(data.runs) : null;
  const active = data?.runs.find((r) => !["done", "failed", "cancelled"].includes(r.status));

  const send = async () => {
    const body = text.trim();
    if (!body || !agentId) return;
    setSending(true);
    try {
      const images = files.filter((f) => f.image).map((f) => f.path);
      const others = files.filter((f) => !f.image).map((f) => f.path);
      const full = others.length ? `${body}\n\n附件：${others.join("、")}` : body;
      const res = await api.post<{ conversationId: string; runId: string; steered: boolean }>(
        conversationId ? `/api/conversations/${conversationId}/messages` : `/api/agents/${agentId}/messages`,
        { text: full, images, ...(conversationId ? {} : { model, effort }) },
      );
      setText("");
      setFiles([]);
      stick.current = true;
      if (!conversationId) nav(`/c/${res.conversationId}`, { replace: true });
      else void load();
      if (res.steered) toast("已作为追加指示发送给正在进行的任务");
      void qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!active) return;
    await api.post(`/api/runs/${active.id}/interrupt`).catch((e) => toast(e.message, "danger"));
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length || !agentId) return;
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 6)) {
        if (f.size > 12 * 1024 * 1024) throw new Error(`${f.name} 超过 12MB`);
        const res = await api.post<{ path: string; image: boolean }>(`/api/agents/${agentId}/uploads`, { name: f.name, data: await fileToBase64(f) });
        setFiles((x) => [...x, { name: f.name, ...res }]);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const a = agent.data;
  return (
    <div className="flex flex-col h-dvh">
      <Header
        back
        backMobileOnly
        title={
          <span className="flex items-center gap-2 min-w-0">
            <span className="truncate">{data?.conversation.title ?? "新对话"}</span>
            {a && (
              <button onClick={() => nav(`/agents/${a.id}`)} className="flex items-center gap-1.5 shrink-0 h-6 px-2 rounded-md bg-surface-2 text-xs font-normal text-muted hover:text-[var(--text)]">
                <span>{a.emoji}</span>
                {a.name}
                <AgentDot agent={a} />
              </button>
            )}
          </span>
        }
      />
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {loading ? (
          <Loading />
        ) : !data ? (
          <div className="flex flex-col items-center text-center px-6 pt-[24dvh] gap-2">
            {a && <span className="text-3xl">{a.emoji}</span>}
            <h1 className="font-display text-2xl font-medium leading-tight">给{a?.name ?? "agent"}派个活</h1>
            <p className="text-sm text-muted">例如：帮我查一下明天上海的天气，整理成三句话</p>
          </div>
        ) : (
          <div className="space-y-5 py-3 max-w-3xl mx-auto">
            {data.runs.map((r) => (
              <RunView key={r.id} run={r} approvals={data.approvals} onChanged={load} />
            ))}
          </div>
        )}
        <div ref={bottom} className="h-2" />
      </div>
      <div className="bg-app px-3 pb-2 pt-1 safe-bottom">
        <div className="max-w-3xl mx-auto">
          <div className="rounded-xl border border-line bg-surface focus-within:border-[color-mix(in_oklab,var(--text)_30%,transparent)] transition-colors">
            {files.length > 0 && (
              <div className="flex gap-1.5 px-2.5 pt-2.5 overflow-x-auto no-scrollbar">
                {files.map((f, i) => (
                  <span key={f.path} className="flex items-center gap-1 text-xs bg-surface-2 border border-line rounded-md pl-2 pr-1 py-0.5 shrink-0">
                    {f.image ? <ImagePlus className="size-3.5" /> : <Paperclip className="size-3.5" />}
                    <span className="max-w-32 truncate">{f.name}</span>
                    <button aria-label="移除" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-1 p-1.5 pl-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Ctrl/⌘/Shift+Enter inserts a newline. Ignore Enter while an IME is composing,
                // and on touch keyboards (no modifier keys) leave Enter as a newline.
                if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
                  setText(el.value);
                } else if (!e.shiftKey && !coarsePointer) {
                  e.preventDefault();
                  void send();
                }
              }}
              enterKeyHint={coarsePointer ? "enter" : "send"}
              rows={1}
              placeholder={active ? "追加指示（任务进行中）" : "说点什么…"}
              className="flex-1 min-w-0 resize-none max-h-48 min-h-9 bg-transparent px-1.5 py-1.5 text-[15px] outline-none field-sizing-content placeholder:text-muted"
            />
              {active && !text.trim() ? (
                <button aria-label="停止" onClick={stop} className="size-8 grid place-items-center rounded-md bg-[var(--text)] text-[var(--bg)] shrink-0">
                  <Square className="size-3 fill-current" />
                </button>
              ) : (
                <button aria-label="发送" aria-busy={sending} onClick={send} disabled={!text.trim() || sending} className={cx("size-8 grid place-items-center rounded-md bg-accent-grad text-white hover:brightness-95 shrink-0", !sending && "disabled:opacity-35")}>
                  {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5 pt-1 min-w-0">
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
            <button aria-label="添加附件" title="添加附件" className="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 shrink-0" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            </button>
            <div className="flex-1 min-w-0" />
            {stats && agentId && <ContextMeter stats={stats} runs={data!.runs} agentId={agentId} />}
            {a && <ModelPicker value={model} agentModel={a.model} onChange={(m) => void changeModel({ model: m })} />}
            {a && <EffortPicker value={effort} agentEffort={a.effort} onChange={(e) => void changeModel({ effort: e })} />}
          </div>
        </div>
      </div>
    </div>
  );
}
