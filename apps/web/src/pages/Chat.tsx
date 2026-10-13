import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ImagePlus, Paperclip, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar, AgentStatus } from "../components/AgentBits";
import { RunView } from "../components/RunView";
import { Empty, Header, Loading, cx, toast } from "../components/ui";
import { api, fileToBase64 } from "../lib/api";
import { useAgentEvents } from "../lib/live";
import type { Agent, AgentEvent, Approval, Conversation, Run } from "../lib/types";

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
        { text: full, images },
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
        title={
          <button className="flex items-center gap-2 max-w-full" onClick={() => a && nav(`/agents/${a.id}`)}>
            {a && <AgentAvatar emoji={a.emoji} size="sm" />}
            <span className="min-w-0 text-left">
              <span className="block truncate">{data?.conversation.title ?? a?.name ?? "对话"}</span>
              {a && <AgentStatus agent={a} />}
            </span>
          </button>
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
          <Empty title={`给${a?.name ?? "agent"}派个活`} hint="例如：帮我查一下明天上海的天气，整理成三句话" />
        ) : (
          <div className="space-y-6 py-4 max-w-3xl mx-auto">
            {data.runs.map((r) => (
              <RunView key={r.id} run={r} approvals={data.approvals} onChanged={load} />
            ))}
          </div>
        )}
        <div ref={bottom} className="h-2" />
      </div>
      <div className="border-t border-line bg-surface safe-bottom">
        {files.length > 0 && (
          <div className="flex gap-2 px-3 pt-2 overflow-x-auto no-scrollbar max-w-3xl mx-auto">
            {files.map((f, i) => (
              <span key={f.path} className="flex items-center gap-1 text-xs bg-surface-2 rounded-lg pl-2 pr-1 py-1 shrink-0">
                {f.image ? <ImagePlus className="size-3.5" /> : <Paperclip className="size-3.5" />}
                <span className="max-w-32 truncate">{f.name}</span>
                <button aria-label="移除" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 p-2.5 max-w-3xl mx-auto">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button aria-label="添加附件" className="size-10 grid place-items-center rounded-full text-muted active:bg-surface-2 shrink-0" onClick={() => fileInput.current?.click()} disabled={uploading}>
            <Paperclip className={cx("size-5", uploading && "animate-pulse")} />
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={1}
            placeholder={active ? "追加指示（任务进行中）" : "说点什么…"}
            className="flex-1 resize-none max-h-40 min-h-10 rounded-2xl bg-surface-2 px-3.5 py-2.5 text-[15px] outline-none field-sizing-content"
          />
          {active && !text.trim() ? (
            <button aria-label="停止" onClick={stop} className="size-10 grid place-items-center rounded-full bg-[var(--danger)] text-white shrink-0">
              <Square className="size-4 fill-current" />
            </button>
          ) : (
            <button aria-label="发送" onClick={send} disabled={!text.trim() || sending} className="size-10 grid place-items-center rounded-full bg-accent text-white disabled:opacity-40 shrink-0">
              <ArrowUp className="size-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
