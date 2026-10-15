import { splitWidgets } from "@constella/protocol";
import { CircleX, Code2, Copy, Loader2, Maximize2, MoreHorizontal, RotateCw, Save, Sparkles, X } from "lucide-react";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useArtifactPanel } from "../lib/artifacts";
import { BRIDGE, buildSrcdoc, chartScriptUrl, themeSnapshot, usesChart, type WidgetTheme } from "../lib/widget-runtime";
import { Markdown } from "./Markdown";
import { cx, toast } from "./ui";
import { GenUIBlock, type BlockHost, type BlockMode, type BlockState, type Saved } from "./genui/Block";
import { StreamUiBlock } from "./streamui/Block";
import { HostContext, type WidgetIssue } from "./widgetHost";
import { BlockTools, ErrorLine, FullScreen, WidgetSkeleton } from "./widgetParts";
import type { MessageUi } from "../lib/streamui/docs";

export { WidgetHostProvider } from "./widgetHost";
export type { WidgetHost, WidgetIssue } from "./widgetHost";

/** The resolved site theme, following changes to the attributes on <html>. */
function useTheme(): WidgetTheme {
  const [theme, setTheme] = useState(themeSnapshot);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme((t) => {
      const next = themeSnapshot();
      return next.css === t.css && next.mode === t.mode ? t : next;
    }));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-palette", "data-font"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/**
 * An agent reply: markdown, with any ui blocks rendered as interactive blocks in place.
 * `keyBase` (run and message id) makes each block's saved-state key; `noHeadingEmoji` is passed
 * through to the markdown parts (the 标题不用表情 setting); `ui` carries the streaming-DSL documents
 * the hub built from its `ui.op` events.
 */
export const RichMessage = memo(function RichMessage({ text, streaming, keyBase, runId, className, noHeadingEmoji, ui }: { text: string; streaming: boolean; keyBase: string; runId: string; className?: string; noHeadingEmoji?: boolean; ui?: MessageUi }) {
  const parts = useMemo(() => splitWidgets(text), [text]);
  if (parts.length === 1 && parts[0]?.kind === "md") return <Markdown text={text} className={className} noHeadingEmoji={noHeadingEmoji} />;
  let n = 0;
  return (
    <div className="space-y-4">
      {parts.map((p, i) => {
        if (p.kind === "md") return <Markdown key={i} text={p.text} className={className} noHeadingEmoji={noHeadingEmoji} />;
        // The index a block takes among all ui blocks: the same one the hub labels its ops with.
        const index = n++;
        const stateKey = `${keyBase}:${index}`;
        const mode = p.closed ? "final" : streaming ? "streaming" : "interrupted";
        if (p.format === "json") {
          return (
            <StreamUiBlock
              key={i}
              title={p.title}
              source={p.source}
              mode={mode}
              stateKey={stateKey}
              runId={runId}
              doc={ui?.docs[String(index)]}
              status={ui?.status[String(index)]}
              issues={ui?.issues[String(index)]}
            />
          );
        }
        if (p.format === "components") return <ComponentWidget key={i} title={p.title} source={p.source} mode={mode} stateKey={stateKey} runId={runId} />;
        return p.closed || !streaming ? (
          <Widget key={i} title={p.title} source={p.source} stateKey={stateKey} runId={runId} interrupted={!p.closed} />
        ) : (
          <WidgetSkeleton key={i} title={p.title} lines={p.source.split("\n").length} />
        );
      })}
    </div>
  );
});

const MAX_INLINE_HEIGHT = 900;
const READY_TIMEOUT_MS = 8000;

/** One sandboxed frame and its bridge: height, state, send, copy, open, errors. */
function Frame({
  source,
  title,
  stateKey,
  fill,
  onError,
  onReady,
}: {
  source: string;
  title: string;
  stateKey: string;
  fill?: boolean;
  onError: (message: string) => void;
  onReady: () => void;
}) {
  const host = useContext(HostContext);
  const theme = useTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const states = host ? host.states : {};
  // The document is built once, with the state and theme of that moment; later theme changes are posted in.
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    if (doc !== null || states === undefined) return;
    setDoc(buildSrcdoc({ source, theme, state: states[stateKey] ?? {}, fill }));
  }, [doc, states, source, theme, stateKey, fill]);
  const sentTheme = useRef(theme);
  useEffect(() => {
    if (sentTheme.current === theme) return;
    sentTheme.current = theme;
    ref.current?.contentWindow?.postMessage({ [BRIDGE]: 1, type: "theme", ...theme }, "*");
  }, [theme]);

  const lastSend = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const m = e.data as { type?: string; [k: string]: unknown } | null;
      if (!m || typeof m !== "object" || !(BRIDGE in m)) return;
      switch (m.type) {
        case "height":
          if (typeof m.height === "number") setHeight(Math.max(40, Math.min(m.height, MAX_INLINE_HEIGHT)));
          break;
        case "ready":
          onReady();
          break;
        case "error":
          onError(String(m.message ?? "未知错误"));
          break;
        case "state":
          if (!host || !m.data || typeof m.data !== "object") break;
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => host.saveState(stateKey, m.data as Record<string, unknown>), 500);
          break;
        case "send": {
          const text = String(m.text ?? "").trim();
          if (!text) break;
          // Only on the owner's own click or key press inside the block, and not twice in a row.
          if (navigator.userActivation && !navigator.userActivation.isActive) break;
          if (Date.now() - lastSend.current < 2000) break;
          lastSend.current = Date.now();
          if (!host) toast("在对话页里才能从界面发消息", "danger");
          else void host.send(text);
          break;
        }
        case "copy":
          void navigator.clipboard.writeText(String(m.text ?? "")).then(
            () => toast("已复制"),
            () => toast("复制失败", "danger"),
          );
          break;
        case "open": {
          const url = String(m.url ?? "");
          if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [host, stateKey, onError, onReady]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  if (doc === null) return <div className="h-[120px] grid place-items-center"><Loader2 className="size-4 animate-spin text-muted" /></div>;
  return (
    <iframe
      ref={ref}
      title={title || "交互界面"}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className="block w-full border-0 bg-transparent"
      style={fill ? { height: "100%" } : { height }}
      scrolling={fill || height >= MAX_INLINE_HEIGHT ? "auto" : "no"}
    />
  );
}

/** A component block (```ui): rendered natively in the flow of the reply, from the first lines on. */
export function ComponentWidget({ title, source, mode, stateKey, runId }: { title: string; source: string; mode: BlockMode; stateKey: string; runId: string }) {
  const host = useContext(HostContext);
  const label = title || "交互界面";
  const [code, setCode] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<BlockState>({ error: null, dropped: 0, diagnostics: [], shown: false });
  const states = host ? host.states : {};
  const blockHost = useMemo<BlockHost>(
    () => ({
      send: (text) => (host ? void host.send(text) : toast("在对话页里才能从界面发消息", "danger")),
      saved: states === undefined ? undefined : ((states[stateKey] as Saved | undefined) ?? null),
      save: (data) => host?.saveState(stateKey, data as Record<string, unknown>),
    }),
    [host, states, stateKey],
  );
  const streaming = mode === "streaming";
  const interrupted = mode === "interrupted";

  // Tell the hub once per problem, after the block has settled.
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (streaming || !host?.reportIssue) return;
    const issues: WidgetIssue[] = [];
    const base = { runId, title: label };
    if (interrupted) issues.push({ ...base, key: `${stateKey}:interrupted`, kind: "interrupted", detail: "回答在界面写完之前中断" });
    if (state.error) issues.push({ ...base, key: `${stateKey}:${state.dropped ? "dropped" : "error"}`, kind: state.dropped ? "dropped" : "error", detail: state.error });
    if (state.diagnostics.length) issues.push({ ...base, key: `${stateKey}:diagnostics`, kind: "diagnostics", detail: state.diagnostics.join("；") });
    const t = setTimeout(() => {
      for (const it of issues) {
        if (reported.current.has(it.key)) continue;
        reported.current.add(it.key);
        host.reportIssue?.(it);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [streaming, interrupted, state.error, state.dropped, state.diagnostics, host, stateKey, runId, label]);

  const problems = [state.error, ...state.diagnostics].filter(Boolean).join("；");
  const fix = host && problems ? () => void host.send(`刚才的「${label}」界面有问题：${problems}。请修复后重新给出这个界面。`) : undefined;
  const finish = host ? () => void host.send(`刚才的「${label}」界面没写完就中断了，请把它补全。`) : undefined;
  return (
    <div className="space-y-1.5">
      <div className="relative group/block">
        {!streaming && <BlockTools code={code} onCode={() => setCode((c) => !c)} onFull={() => setFull(true)} onReload={() => setReload((r) => r + 1)} source={source} badge={state.diagnostics.length} />}
        {code && (
          <div className="rounded-xl border border-line bg-surface-2 overflow-hidden">
            {state.diagnostics.length > 0 && (
              <ul className="px-3.5 py-2 border-b border-line text-xs text-warn space-y-0.5">
                {state.diagnostics.map((d) => (
                  <li key={d}>· {d}</li>
                ))}
              </ul>
            )}
            <pre className="max-h-[28rem] overflow-auto px-3.5 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all">{source}</pre>
          </div>
        )}
        <div className={cx(code && "hidden")}>
          <GenUIBlock source={source} mode={mode} host={blockHost} onState={setState} reloadKey={reload} />
        </div>
      </div>
      {interrupted && (
        <div className="flex items-center gap-2 text-xs text-muted min-w-0">
          <CircleX className="size-3.5 shrink-0 text-warn" strokeWidth={1.8} />
          <span className="truncate">回答中断了，界面只显示了已生成的部分</span>
          {finish && <button className="shrink-0 hover:text-[var(--text)]" onClick={finish}>让 agent 补全</button>}
        </div>
      )}
      {state.error && !streaming && (state.shown && state.dropped ? (
        <div className="flex items-center gap-2 text-xs text-muted min-w-0">
          <CircleX className="size-3.5 shrink-0 text-warn" strokeWidth={1.8} />
          <span className="truncate" title={state.error}>界面有一部分写错了，已跳过：{state.error}</span>
          {fix && <button className="shrink-0 hover:text-[var(--text)]" onClick={fix}>让 agent 修复</button>}
        </div>
      ) : (
        <ErrorLine error={state.error} onRetry={() => setReload((r) => r + 1)} onFix={fix} />
      ))}
      {full && (
        <FullScreen title={label} onClose={() => setFull(false)}>
          <div className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5">
              <GenUIBlock source={source} mode={mode === "streaming" ? "final" : mode} host={blockHost} eager />
            </div>
          </div>
        </FullScreen>
      )}
    </div>
  );
}

/** The escape hatch (```ui-html): a self-contained page in a sandboxed frame, for what the components can't do. */
export function Widget({ title, source, stateKey, runId, interrupted }: { title: string; source: string; stateKey: string; runId: string; interrupted?: boolean }) {
  const host = useContext(HostContext);
  const { open: openArtifact } = useArtifactPanel();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState(false);
  const [full, setFull] = useState(false);
  const [gen, setGen] = useState(0);
  const [saving, setSaving] = useState(false);
  const onError = useCallback((m: string) => setError((e) => e ?? m), []);
  const onReady = useCallback(() => setReady(true), []);
  useEffect(() => {
    if (ready || error) return;
    const t = setTimeout(() => setError((e) => e ?? "界面长时间没有加载完成"), READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [ready, error, gen]);
  const label = title || "交互界面";

  const reload = () => {
    setError(null);
    setReady(false);
    setGen((g) => g + 1);
  };
  const saveArtifact = async () => {
    if (!host) return;
    setSaving(true);
    try {
      const chartInline = usesChart(source) ? await fetch(chartScriptUrl()).then((r) => r.text()) : undefined;
      const html = buildSrcdoc({ source, theme: themeSnapshot(), state: host.states?.[stateKey] ?? {}, fill: true, chartInline }).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "");
      const a = await api.post<{ id: string; version: number }>("/api/artifacts", { conversationId: host.conversationId, runId, title: label, html });
      toast("已保存到成果");
      openArtifact(a.id, a.version);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setSaving(false);
    }
  };
  const fix = host && error ? () => void host.send(`刚才的「${label}」界面运行出错：${error}。请修复后重新给出这个界面。`) : undefined;

  return (
    <div className="space-y-1.5">
      <div className="relative group/block">
        <BlockTools code={code} onCode={() => setCode((c) => !c)} onFull={() => setFull(true)} onReload={reload} source={source} onSave={host ? () => void saveArtifact() : undefined} saving={saving} />
        {code && <pre className="max-h-[28rem] overflow-auto rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all">{source}</pre>}
        <div className={cx("rounded-xl border border-line overflow-hidden", code && "hidden")}>
          <Frame key={gen} source={source} title={label} stateKey={stateKey} onError={onError} onReady={onReady} />
        </div>
      </div>
      {interrupted && (
        <div className="flex items-center gap-2 text-xs text-muted min-w-0">
          <CircleX className="size-3.5 shrink-0 text-warn" strokeWidth={1.8} />
          <span className="truncate">回答中断了，界面可能不完整</span>
          {host && <button className="shrink-0 hover:text-[var(--text)]" onClick={() => void host.send(`刚才的「${label}」界面没写完就中断了，请把它补全。`)}>让 agent 补全</button>}
        </div>
      )}
      {error && <ErrorLine error={error} onRetry={reload} onFix={fix} />}
      {full && (
        <FullScreen title={label} onClose={() => setFull(false)}>
          <Frame source={source} title={label} stateKey={stateKey} fill onError={onError} onReady={onReady} />
        </FullScreen>
      )}
    </div>
  );
}


