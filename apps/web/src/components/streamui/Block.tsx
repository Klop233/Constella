import { emptyDoc, safeUrl, type UIDoc, type UIStatus } from "@constella/protocol";
import { CircleX } from "lucide-react";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildDocFromSource } from "../../lib/streamui/docs";
import { UiBlockRuntime } from "../../lib/streamui/runtime";
import type { Ctx } from "../genui/components";
import { cx, toast } from "../ui";
import { HostContext } from "../widgetHost";
import { BlockTools, ErrorLine, FullScreen, WidgetSkeleton } from "../widgetParts";
import { UiTree } from "./Tree";

// A streaming UI block (```ui-json) in a reply. The tree comes from the ops the hub forwarded while
// the reply was written; when those are missing (a pruned history, a device that missed them) it is
// rebuilt from the reply text, which is why the interface survives a refresh either way.
//
// What the owner types into the interface lives in the block's runtime, not in the tree, and is saved
// with the conversation — so a later update from the model can't clear it and a reload doesn't lose it.

export interface StreamUiBlockProps {
  title: string;
  source: string;
  /** streaming: still being written · final: complete · interrupted: the reply ended mid-block. */
  mode: "streaming" | "final" | "interrupted";
  stateKey: string;
  runId: string;
  /** The document the hub built from `ui.op` events, when they arrived. */
  doc?: UIDoc;
  status?: UIStatus;
  issues?: string[];
}

function StreamUiBlockInner({ title, source, mode, stateKey, runId, doc: docFromEvents, status, issues }: StreamUiBlockProps) {
  const host = useContext(HostContext);
  const label = title || "交互界面";
  const streaming = mode === "streaming";
  const [code, setCode] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);

  const hostRef = useRef(host);
  hostRef.current = host;
  const noteRef = useRef<(message: string) => void>(() => {});
  noteRef.current = (message) => setNotes((prev) => (prev.includes(message) ? prev : [...prev, message].slice(-5)));

  // No ops for this block: read the reply itself, which is the durable copy of what the model wrote.
  const fromSource = useMemo(() => (docFromEvents ? null : buildDocFromSource(source)), [docFromEvents, source, reload]);
  const current = docFromEvents ?? fromSource ?? emptyDoc();

  const runtimeRef = useRef<UiBlockRuntime | null>(null);
  runtimeRef.current ??= new UiBlockRuntime({
    doc: current,
    send: (text) => {
      const h = hostRef.current;
      if (h) void h.send(text);
      else toast("在对话页里才能从界面发消息", "danger");
    },
    report: (message) => noteRef.current(message),
  });
  const runtime = runtimeRef.current;

  useLayoutEffect(() => {
    runtime.setDoc(current);
  }, [runtime, current]);

  // Restore what the owner had typed, once the saved states have loaded (`states` is undefined while
  // they are still on the way, and the block may mount before they arrive).
  const restored = useRef(false);
  const savedStates = host?.states;
  useLayoutEffect(() => {
    if (restored.current || !host || savedStates === undefined) return;
    restored.current = true;
    runtime.restoreValues((savedStates[stateKey] as { values?: Record<string, unknown> } | undefined)?.values);
  }, [host, savedStates, runtime, stateKey]);

  // Save it back, debounced, and only when there is something to save.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () =>
      runtime.onChange(() => {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const h = hostRef.current;
          const values = runtime.values();
          if (!h || !Object.keys(values).length) return;
          h.saveState(stateKey, { values });
        }, 500);
      }),
    [runtime, stateKey],
  );
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const snapshot = useSyncExternalStore(
    useCallback((fn: () => void) => runtime.subscribeRoots(fn), [runtime]),
    useCallback(() => runtime.rootsSnapshot(), [runtime]),
    useCallback(() => runtime.rootsSnapshot(), [runtime]),
  );

  const ctx = useMemo<Ctx>(
    () => ({
      send: (text) => {
        const h = hostRef.current;
        if (h) void h.send(text);
        else toast("在对话页里才能从界面发消息", "danger");
      },
      copy: (text) => void navigator.clipboard.writeText(text).then(() => toast("已复制"), () => toast("复制失败", "danger")),
      open: (url) => {
        const safe = safeUrl(url);
        if (safe) window.open(safe, "_blank", "noopener,noreferrer");
      },
      // Components that only have a plain "send this" affordance go through the dispatcher as well.
      dispatch: (action) => runtime.dispatch(action, ""),
    }),
    [runtime],
  );

  // Tell the hub once per problem, after the block has settled, so reflection can learn from it.
  const reported = useRef(new Set<string>());
  const problemText = [...(issues ?? current.issues), ...notes].join("；");
  useEffect(() => {
    if (streaming || !host?.reportIssue || !problemText) return;
    const key = `${stateKey}:${problemText.slice(0, 40)}`;
    const t = setTimeout(() => {
      if (reported.current.has(key)) return;
      reported.current.add(key);
      host.reportIssue?.({ key, runId, title: label, kind: "diagnostics", detail: problemText.slice(0, 400) });
    }, 1500);
    return () => clearTimeout(t);
  }, [streaming, host, problemText, stateKey, runId, label]);

  const problems = [...(issues ?? current.issues), ...notes];
  const fix = host && problems.length ? () => void host.send(`刚才的「${label}」界面有问题：${problems.join("；")}。请修复后重新给出这个界面。`) : undefined;
  const finish = host ? () => void host.send(`刚才的「${label}」界面没写完就中断了，请把它补全。`) : undefined;
  const empty = snapshot.count === 0;

  return (
    <div className="space-y-1.5">
      <div className="relative group/block">
        {!streaming && <BlockTools code={code} onCode={() => setCode((c) => !c)} onFull={() => setFull(true)} onReload={() => setReload((r) => r + 1)} source={source} badge={problems.length} />}
        {code ? (
          <div className="rounded-xl border border-line bg-surface-2 overflow-hidden">
            {problems.length > 0 && (
              <ul className="px-3.5 py-2 border-b border-line text-xs text-warn space-y-0.5">
                {problems.map((d) => (
                  <li key={d}>· {d}</li>
                ))}
              </ul>
            )}
            <pre className="max-h-[28rem] overflow-auto px-3.5 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all">{source}</pre>
          </div>
        ) : empty && streaming ? (
          <WidgetSkeleton title={label} lines={source.split("\n").length} />
        ) : empty ? (
          <div className="text-[13px] text-muted">这个界面还没有内容</div>
        ) : (
          <UiTree runtime={runtime} ctx={ctx} />
        )}
      </div>
      {interruptedLine(mode, finish)}
      {status === "failed" && !streaming && (
        <div className="flex items-center gap-2 text-xs text-muted min-w-0">
          <CircleX className="size-3.5 shrink-0 text-warn" strokeWidth={1.8} />
          <span className="truncate">界面生成中途停了，只显示了已经完成的部分</span>
        </div>
      )}
      {problems.length > 0 && !code && !streaming && <ErrorLine error={problems.join("；")} onRetry={() => setReload((r) => r + 1)} onFix={fix} />}
      {full && (
        <FullScreen title={label} onClose={() => setFull(false)}>
          <div className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5">
              <UiTree runtime={runtime} ctx={ctx} />
            </div>
          </div>
        </FullScreen>
      )}
    </div>
  );
}

/**
 * Memoized on what actually changes the drawing: a reply re-renders whenever any event arrives, and
 * a block whose tree didn't move must not be rebuilt.
 */
export const StreamUiBlock = memo(
  StreamUiBlockInner,
  (a, b) =>
    a.doc === b.doc &&
    a.mode === b.mode &&
    a.source === b.source &&
    a.stateKey === b.stateKey &&
    a.title === b.title &&
    a.runId === b.runId &&
    a.status === b.status &&
    (a.issues?.join("|") ?? "") === (b.issues?.join("|") ?? ""),
);

function interruptedLine(mode: StreamUiBlockProps["mode"], finish?: () => void) {  if (mode !== "interrupted") return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted min-w-0">
      <CircleX className="size-3.5 shrink-0 text-warn" strokeWidth={1.8} />
      <span className="truncate">回答中断了，界面只显示了已生成的部分</span>
      {finish && <button className="shrink-0 hover:text-[var(--text)]" onClick={finish}>让 agent 补全</button>}
    </div>
  );
}
