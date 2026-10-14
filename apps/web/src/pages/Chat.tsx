import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Archive, ArchiveRestore, ImagePlus, Loader2, Monitor, Paperclip, Plus, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentDot } from "../components/AgentBits";
import { ConversationArtifacts } from "../components/ArtifactList";
import { ContextMeter, EffortPicker, ModelPicker, RunTimeoutPicker } from "../components/ChatControls";
import { CONTINUE_TEXT, latestStats, RunView } from "../components/RunView";
import { Button, Empty, Header, IconButton, Loading, cx, toast } from "../components/ui";
import { WidgetHostProvider, type WidgetHost } from "../components/Widget";
import { api, ApiError, fileToBase64 } from "../lib/api";
import { useAppearance } from "../lib/appearance";
import { useAgentEvents, useHubEvents } from "../lib/live";
import { openInstanceWindow, useInstanceWindow } from "../lib/instanceWindow";
import type { Agent, AgentEvent, Approval, Conversation, Desktop, Effort, Incident, Run } from "../lib/types";

const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

interface ConvData {
  conversation: Conversation;
  runs: Run[];
  approvals: Approval[];
  incidents: Incident[];
}

export default function Chat() {
  const { conversationId, id: newAgentId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [data, setData] = useState<ConvData | null>(null);
  const [loading, setLoading] = useState(!!conversationId);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; path: string; image: boolean }[]>([]);
  const [sending, setSending] = useState(false);
  // This conversation's model / effort; null follows the agent.
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  // Likewise the single-turn time limit (0 = none).
  const [runTimeout, setRunTimeout] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const agentId = data?.conversation.agent_id ?? newAgentId;
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ name: string }>("/api/me"), staleTime: 300_000 });
  const agent = useQuery({ queryKey: ["agent", agentId], queryFn: () => api.get<Agent>(`/api/agents/${agentId}`), enabled: !!agentId });

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      setData(await api.get<ConvData>(`/api/conversations/${conversationId}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setModel(data?.conversation.model ?? null);
    setEffort(data?.conversation.effort ?? null);
    setRunTimeout(data?.conversation.run_timeout_minutes ?? null);
  }, [data?.conversation.id, data?.conversation.model, data?.conversation.effort, data?.conversation.run_timeout_minutes]);

  const changeModel = async (patch: { model?: string | null; effort?: Effort | null; runTimeoutMinutes?: number | null }) => {
    if (patch.model !== undefined) setModel(patch.model);
    if (patch.effort !== undefined) setEffort(patch.effort);
    if (patch.runTimeoutMinutes !== undefined) setRunTimeout(patch.runTimeoutMinutes);
    if (!conversationId) return; // a new conversation sends it with the first message
    try {
      await api.patch(`/api/conversations/${conversationId}`, patch);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };

  useEffect(() => {
    setData(null);
    setMissing(false);
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
  // Diagnosis reports and supervisor questions for this conversation arrive as hub notifications.
  const onHub = useCallback(
    (type: string, payload: unknown) => {
      const conv = (payload as { conversationId?: string | null } | null)?.conversationId;
      if (type === "incident" && conversationId && (conv === conversationId || conv === undefined)) void load();
    },
    [conversationId, load],
  );
  useHubEvents(onHub);

  useLayoutEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  });

  const { usage: showUsage } = useAppearance();
  const stats = showUsage && data ? latestStats(data.runs) : null;
  const active = data?.runs.find((r) => !["done", "failed", "cancelled"].includes(r.status));
  // The last task ended abnormally: an empty send (or just clicking send) continues it.
  const interrupted = !active && data?.runs.at(-1)?.status === "failed";
  // The agent is waiting on a question: whatever is typed goes to it as the answer.
  const asked = !!active && active.status === "waiting_approval" && !!data?.approvals.some((ap) => ap.kind === "decision" && ap.run_id === active.id);

  const send = async () => {
    const body = text.trim() || (interrupted && !files.length ? CONTINUE_TEXT : "");
    if (!body || !agentId) return;
    setSending(true);
    try {
      const images = files.filter((f) => f.image).map((f) => f.path);
      const others = files.filter((f) => !f.image).map((f) => f.path);
      const full = others.length ? `${body}\n\n附件：${others.join("、")}` : body;
      const res = await api.post<{ conversationId: string; runId: string; steered: boolean }>(
        conversationId ? `/api/conversations/${conversationId}/messages` : `/api/agents/${agentId}/messages`,
        { text: full, images, ...(conversationId ? {} : { model, effort, runTimeoutMinutes: runTimeout }) },
      );
      setText("");
      setFiles([]);
      stick.current = true;
      if (!conversationId) nav(`/c/${res.conversationId}`, { replace: true });
      else void load();
      if (res.steered) toast(asked ? "已回答" : "已作为追加指示发送给正在进行的任务");
      void qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setSending(false);
    }
  };

  // Interactive blocks in replies: what the owner entered in them, and messages sent from them.
  const widgetStates = useQuery({
    queryKey: ["widget-state", conversationId],
    queryFn: () => api.get<Record<string, Record<string, unknown>>>(`/api/widget-state?conversation=${conversationId}`),
    enabled: !!conversationId,
    staleTime: Infinity,
  });
  const widgetHost = useMemo<WidgetHost | null>(
    () =>
      conversationId
        ? {
            conversationId,
            states: widgetStates.isError ? {} : widgetStates.data,
            saveState: (key, value) => {
              qc.setQueryData<Record<string, Record<string, unknown>>>(["widget-state", conversationId], (cur) => ({ ...cur, [key]: value }));
              api.put(`/api/widget-state/${encodeURIComponent(key)}`, { conversationId, data: value }).catch((e) => toast(e instanceof Error ? e.message : String(e), "danger"));
            },
            send: async (body) => {
              try {
                const res = await api.post<{ steered: boolean }>(`/api/conversations/${conversationId}/messages`, { text: body });
                stick.current = true;
                void load();
                if (res.steered) toast("已作为追加指示发送给正在进行的任务");
                void qc.invalidateQueries({ queryKey: ["overview"] });
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), "danger");
              }
            },
          }
        : null,
    [conversationId, widgetStates.data, widgetStates.isError, qc, load],
  );

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
  const isNew = !conversationId && !loading;
  const toggleArchive = async () => {
    if (!data) return;
    const archived = !data.conversation.archived_at;
    try {
      await api.patch(`/api/conversations/${data.conversation.id}`, { archived });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      toast(archived ? "已归档，可在助手详情页找到" : "已取消归档");
      if (archived) nav(`/agents/${data.conversation.agent_id}`);
      else void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  };
  const composer = (
    <div className="w-full max-w-3xl mx-auto">
      <div className="rounded-2xl border border-line bg-surface focus-within:border-[color-mix(in_oklab,var(--text)_30%,transparent)] transition-colors">
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
          placeholder={asked ? "直接写下你的回答…" : active ? "追加指示（任务进行中）" : interrupted ? "任务中断了，直接发送即可继续，也可以补充说明…" : !conversationId ? `今天想让${a?.name ?? "agent"}做点什么？` : "回复…"}
          className="flex-1 min-w-0 resize-none max-h-48 min-h-8 bg-transparent px-1.5 py-1.5 text-sm outline-none field-sizing-content placeholder:text-muted"
        />
          {active && !text.trim() ? (
            <button aria-label="停止" onClick={stop} className="size-7 mb-0.5 grid place-items-center rounded-lg bg-[var(--text)] text-[var(--bg)] shrink-0">
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button aria-label={!text.trim() && interrupted ? "继续" : "发送"} title={!text.trim() && interrupted ? "继续中断的任务" : undefined} aria-busy={sending} onClick={send} disabled={(!text.trim() && !interrupted) || sending} className={cx("size-7 mb-0.5 grid place-items-center rounded-lg shrink-0 transition-colors", text.trim() || interrupted || sending ? "bg-accent text-white hover:brightness-95" : "bg-surface-2 text-muted")}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 pt-1 min-w-0">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <button aria-label="添加附件" title="添加附件" className="size-7 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 shrink-0" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
        <div className="flex-1 min-w-0" />
        {stats && agentId && conversationId && <ContextMeter stats={stats} runs={data!.runs} agentId={agentId} conversationId={conversationId} />}
        {a && <ModelPicker value={model} agentModel={a.model} onChange={(m) => void changeModel({ model: m })} />}
        {a && <EffortPicker value={effort} agentEffort={a.effort} model={model ?? a.model} onChange={(e) => void changeModel({ effort: e })} />}
        {a && <RunTimeoutPicker value={runTimeout} onChange={(m) => void changeModel({ runTimeoutMinutes: m })} />}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col h-dvh">
      <Header
        back
        backMobileOnly
        right={
          conversationId && (
            <div className="flex items-center gap-1">
              {agentId && data && <InstanceButton agentId={agentId} runs={data.runs} />}
              <ConversationArtifacts conversationId={conversationId} />
              {data && (
                <IconButton label={data.conversation.archived_at ? "取消归档" : "归档"} onClick={() => void toggleArchive()}>
                  {data.conversation.archived_at ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                </IconButton>
              )}
            </div>
          )
        }
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
        ) : missing ? (
          <Empty title="这个对话不存在或已删除" hint="从左侧选一个对话，或者开始新对话" action={a && <Button size="sm" onClick={() => nav(`/agents/${a.id}/chat`)}>开始新对话</Button>} />
        ) : isNew ? (
          // New conversation: a greeting with the composer right under it, Claude-style.
          <div className="min-h-full flex flex-col justify-center pb-[12dvh]">
            <h1 className="flex items-center justify-center gap-3 mb-6 font-display text-[26px] sm:text-3xl font-medium text-center">
              <span className="text-2xl sm:text-3xl">{a?.emoji ?? "✨"}</span>
              {greeting()}
              {me.data?.name ? `，${me.data.name}` : ""}
            </h1>
            {composer}
          </div>
        ) : !data ? null : (
          <WidgetHostProvider value={widgetHost}>
            <div className="space-y-8 pt-4 pb-6 max-w-3xl mx-auto">
              {data.runs.map((r) => (
                <RunView key={r.id} run={r} approvals={data.approvals} incidents={data.incidents} onChanged={load} />
              ))}
            </div>
          </WidgetHostProvider>
        )}
        <div ref={bottom} className="h-2" />
      </div>
      {!isNew && <div className="bg-app px-3 pb-2 pt-1 safe-bottom">{composer}</div>}
    </div>
  );
}

/**
 * Opens the floating instance window on the instance this conversation is using: the one its run holds right now,
 * else the last one it touched, else one bound to the agent. The dot means the agent is operating it now.
 */
function InstanceButton({ agentId, runs }: { agentId: string; runs: Run[] }) {
  const list = useQuery({ queryKey: ["desktops"], queryFn: () => api.get<Desktop[]>("/api/desktops") });
  const shown = useInstanceWindow();
  const desktops = list.data ?? [];
  const runIds = new Set(runs.map((r) => r.id));
  const held = desktops.find((d) => d.leaseInfo.holder === "agent" && runIds.has(d.leaseInfo.runId));
  const used = runs
    .flatMap((r) => r.events)
    .findLast((e) => e.type === "desktop.action" || e.type === "desktop.help");
  const usedId = used && "desktopId" in used ? used.desktopId : undefined;
  const target = held ?? desktops.find((d) => d.id === usedId) ?? desktops.find((d) => d.agentIds.includes(agentId));
  if (!target) return null;
  return (
    <IconButton label={held ? "小窗看它操作实例" : "小窗看实例"} onClick={() => openInstanceWindow(target.id)} className={cx("relative", shown === target.id && "text-[var(--text)] bg-surface-2")}>
      <Monitor className="size-4" />
      {held && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent animate-pulse" />}
    </IconButton>
  );
}

/** Time-of-day greeting for the empty new-conversation screen. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}

