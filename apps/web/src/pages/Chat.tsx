import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IMAGE_EXT, withAttachments } from "@constella/protocol";
import { ArrowUp, Archive, ArchiveRestore, Loader2, Monitor, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ConversationArtifacts } from "../components/ArtifactList";
import { ComposerAttachments, type PendingFile } from "../components/Attachments";
import { ContextMeter, EffortPicker, ModelPicker, RunTimeoutPicker } from "../components/ChatControls";
import { CONTINUE_TEXT, latestStats, RunView } from "../components/RunView";
import { Button, Empty, Header, IconButton, Loading, cx, toast } from "../components/ui";
import { WidgetHostProvider, type WidgetHost } from "../components/Widget";
import { api, ApiError, fileToBase64 } from "../lib/api";
import { useAppearance } from "../lib/appearance";
import { draftKey, readDraft, writeDraft } from "../lib/drafts";
import { takeFiles } from "../lib/share";
import { useAgentEvents, useHubEvents } from "../lib/live";
import { openInstanceWindow, useInstanceWindow } from "../lib/instanceWindow";
import type { Agent, AgentEvent, Approval, Conversation, Desktop, Effort, Incident, Run } from "../lib/types";

const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const MAX_FILES = 10;
/** The hub passes at most this many images to the model per message. */
const MAX_IMAGES = 8;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

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
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  // This conversation's model / effort; null follows the agent.
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  // Likewise the single-turn time limit (0 = none).
  const [runTimeout, setRunTimeout] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadVersion = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const agentId = data?.conversation.agent_id ?? newAgentId;
  // What was typed but not sent survives leaving the page (and the phone killing the app).
  const draft = draftKey(conversationId, newAgentId);
  useEffect(() => setText(readDraft(draft)), [draft]);
  const edit = (value: string) => {
    setText(value);
    writeDraft(draft, value);
  };
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ name: string }>("/api/me"), staleTime: 300_000 });
  const agent = useQuery({ queryKey: ["agent", agentId], queryFn: () => api.get<Agent>(`/api/agents/${agentId}`), enabled: !!agentId });

  const load = useCallback(async () => {
    if (!conversationId) return;
    clearTimeout(reloadTimer.current);
    reloadTimer.current = undefined;
    const version = ++loadVersion.current;
    try {
      const next = await api.get<ConvData>(`/api/conversations/${conversationId}`);
      if (version !== loadVersion.current) return;
      setData(next);
    } catch (err) {
      if (version !== loadVersion.current) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [conversationId]);

  const scheduleLoad = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = undefined;
      void load();
    }, 100);
  }, [load]);

  useEffect(
    () => () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = undefined;
    },
    [conversationId],
  );

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
    loadVersion.current++;
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
        if (idx < 0) return cur;
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
      // Keep the updater pure. The event may arrive before the first conversation load, or for a
      // run created on another tab; either case needs a coalesced refresh outside setState.
      if (!data?.runs.some((r) => r.id === ev.runId)) scheduleLoad();
      if (ev.type === "approval.requested" || ev.type === "approval.resolved" || (ev.type === "run.status" && ["done", "failed", "cancelled"].includes(ev.status))) {
        scheduleLoad();
      }
    },
    [conversationId, data?.runs, scheduleLoad],
  );
  useAgentEvents(onEvent);
  // Diagnosis reports and supervisor questions for this conversation arrive as hub notifications.
  const onHub = useCallback(
    (type: string, payload: unknown) => {
      const conv = (payload as { conversationId?: string | null } | null)?.conversationId;
      if (type === "incident" && conversationId && (conv === conversationId || conv === undefined)) scheduleLoad();
    },
    [conversationId, scheduleLoad],
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

  const uploading = files.some((f) => !f.path);
  const canSend = !!text.trim() || interrupted || (files.length > 0 && !uploading);
  const send = async () => {
    if (uploading) return toast("附件还在上传，稍等一下");
    const body = text.trim() || (interrupted && !files.length ? CONTINUE_TEXT : "");
    if ((!body && !files.length) || !agentId) return;
    setSending(true);
    try {
      const paths = files.map((f) => f.path!);
      const images = files.filter((f) => f.image).map((f) => f.path!);
      const full = withAttachments(body, paths);
      const res = await api.post<{ conversationId: string; runId: string; steered: boolean }>(
        conversationId ? `/api/conversations/${conversationId}/messages` : `/api/agents/${agentId}/messages`,
        { text: full, images, ...(conversationId ? {} : { model, effort, runTimeoutMinutes: runTimeout }) },
      );
      setText("");
      writeDraft(draft, "");
      clearFiles();
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
            reportIssue: (issue) => void api.post("/api/widget-issues", { conversationId, ...issue }).catch(() => {}),
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

  const removeFile = (key: string) =>
    setFiles((x) => {
      const f = x.find((y) => y.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return x.filter((y) => y.key !== key);
    });
  const clearFiles = () =>
    setFiles((x) => {
      for (const f of x) if (f.preview) URL.revokeObjectURL(f.preview);
      return [];
    });
  // Picked, pasted or dropped files: each shows up right away (images with a local thumbnail) and uploads in the background.
  const upload = (list: File[]) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!list.length || !agentId) return;
    const room = MAX_FILES - files.length;
    let imageRoom = MAX_IMAGES - files.filter((f) => f.image).length;
    const accepted: { file: File; item: PendingFile }[] = [];
    const rejected: string[] = [];
    for (const raw of list) {
      const file = named(raw);
      const image = IMAGE_TYPE.test(file.type) || IMAGE_EXT.test(file.name);
      if (accepted.length >= room || (image && imageRoom <= 0)) rejected.push(`最多 ${MAX_FILES} 个附件、${MAX_IMAGES} 张图片`);
      else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} 超过 12MB`);
      else if (!file.size) rejected.push(`${file.name} 是空文件或文件夹`);
      else {
        if (image) imageRoom--;
        accepted.push({ file, item: { key: `${Date.now()}-${Math.random()}`, name: file.name, image, preview: image ? URL.createObjectURL(file) : undefined } });
      }
    }
    if (rejected.length) toast([...new Set(rejected)].join("；"), "danger");
    if (!accepted.length) return;
    setFiles((x) => [...x, ...accepted.map((a) => a.item)]);
    for (const { file, item } of accepted) {
      fileToBase64(file)
        .then((data) => api.post<{ path: string; image: boolean }>(`/api/agents/${agentId}/uploads`, { name: file.name, data }))
        // The hub decides what the model can take as an image (by extension); anything else goes as a file.
        .then((res) => setFiles((x) => x.map((f) => (f.key === item.key ? { ...f, path: res.path, image: res.image } : f))))
        .catch((err) => {
          removeFile(item.key);
          toast(`${file.name} 上传失败：${err instanceof Error ? err.message : String(err)}`, "danger");
        });
    }
  };

  // Files shared from another app (the /share page) land in the composer of the new conversation.
  useEffect(() => {
    const shared = takeFiles(newAgentId);
    if (shared.length) upload(shared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newAgentId]);

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
      <div
        className={cx(
          "rounded-2xl border bg-surface transition-colors",
          dragging ? "border-[color-mix(in_oklab,var(--color-accent)_60%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_5%,var(--surface))]" : "border-line focus-within:border-[color-mix(in_oklab,var(--text)_30%,transparent)]",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          upload(Array.from(e.dataTransfer.files));
        }}
      >
        {files.length > 0 && <ComposerAttachments files={files} onRemove={removeFile} />}
        <div className="flex items-end gap-1 p-1.5 pl-2">
        <textarea
          value={text}
          onChange={(e) => edit(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (!pasted.length) return;
            // Office and web selections also carry a rendered image of themselves; there the text is what was meant.
            if (e.clipboardData.getData("text/html") && e.clipboardData.getData("text/plain").trim()) return;
            e.preventDefault();
            upload(pasted);
          }}
          onKeyDown={(e) => {
            // Enter sends; Ctrl/⌘/Shift+Enter inserts a newline. Ignore Enter while an IME is composing,
            // and on touch keyboards (no modifier keys) leave Enter as a newline.
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              const el = e.currentTarget;
              el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
              edit(el.value);
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
          {active && !text.trim() && !files.length ? (
            <button aria-label="停止" onClick={stop} className="size-7 mb-0.5 grid place-items-center rounded-lg bg-[var(--text)] text-[var(--bg)] shrink-0">
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button aria-label={!text.trim() && interrupted ? "继续" : "发送"} title={!text.trim() && interrupted ? "继续中断的任务" : undefined} aria-busy={sending} onClick={send} disabled={!canSend || sending} className={cx("size-7 mb-0.5 grid place-items-center rounded-lg shrink-0 transition-colors", canSend || sending ? "bg-accent text-white hover:brightness-95" : "bg-surface-2 text-muted")}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 pt-1 min-w-0">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(Array.from(e.target.files ?? []))} />
        <button aria-label="添加附件" title="添加附件" className="size-7 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 shrink-0" onClick={() => fileInput.current?.click()}>
          <Plus className="size-4" />
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
          // Claude-style breadcrumb: the agent (muted, opens its page) / this conversation.
          <span className="flex items-center gap-1.5 min-w-0">
            {a && (
              <>
                <button onClick={() => nav(`/agents/${a.id}`)} title={a.name} className="flex items-center gap-1.5 shrink-0 max-w-[40%] font-normal text-muted hover:text-[var(--text)]">
                  <span>{a.emoji}</span>
                  <span className="truncate hidden sm:inline">{a.name}</span>
                </button>
                <span className="text-muted font-normal shrink-0">/</span>
              </>
            )}
            <span className="truncate">{data?.conversation.title ?? "新对话"}</span>
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

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;

/** Clipboard images come in as "image.png"; give them a name that tells them apart. */
function named(file: File): File {
  if (!/^image\.\w+$/.test(file.name) && file.name) return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const d = new Date();
  const stamp = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  return new File([file], `粘贴的图片-${stamp}.${ext}`, { type: file.type });
}

/** Time-of-day greeting for the empty new-conversation screen. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}
