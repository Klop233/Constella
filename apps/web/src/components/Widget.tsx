import { splitWidgets } from "@constella/protocol";
import { CircleX, Code2, Copy, Loader2, Maximize2, MoreHorizontal, RotateCw, Save, Sparkles, X } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useArtifactPanel } from "../lib/artifacts";
import { BRIDGE, buildSrcdoc, chartScriptUrl, themeSnapshot, usesChart, type WidgetTheme } from "../lib/widget-runtime";
import { Markdown } from "./Markdown";
import { MenuDivider, MenuItem, Popover, cx, toast } from "./ui";

/** What the conversation page lends interactive blocks: sending a message, and the saved block states. */
export interface WidgetHost {
  conversationId: string;
  send: (text: string) => Promise<void>;
  /** Saved states by block key; undefined while loading. */
  states: Record<string, Record<string, unknown>> | undefined;
  saveState: (key: string, data: Record<string, unknown>) => void;
}

const HostContext = createContext<WidgetHost | null>(null);
export const WidgetHostProvider = HostContext.Provider;

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
 * An agent reply: markdown, with any ```ui blocks rendered as interactive blocks in place.
 * `keyBase` (run and message id) makes each block's saved-state key.
 */
export const RichMessage = memo(function RichMessage({ text, streaming, keyBase, runId, className }: { text: string; streaming: boolean; keyBase: string; runId: string; className?: string }) {
  const parts = useMemo(() => splitWidgets(text), [text]);
  if (parts.length === 1 && parts[0]?.kind === "md") return <Markdown text={text} className={className} />;
  let n = 0;
  return (
    <div className="space-y-3">
      {parts.map((p, i) =>
        p.kind === "md" ? (
          <Markdown key={i} text={p.text} className={className} />
        ) : p.closed || !streaming ? (
          <Widget key={i} title={p.title} source={p.source} stateKey={`${keyBase}:${n++}`} runId={runId} />
        ) : (
          <WidgetSkeleton key={i} title={p.title} lines={p.source.split("\n").length} />
        ),
      )}
    </div>
  );
});

function WidgetSkeleton({ title, lines }: { title: string; lines: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="h-8 flex items-center gap-2 px-3 text-[12.5px] text-muted border-b border-line">
        <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={1.8} />
        <span className="truncate">正在生成{title ? `「${title}」` : "交互界面"}…</span>
        <span className="ml-auto tabular-nums text-[11px]">{lines} 行</span>
      </div>
      <div className="p-3.5 space-y-2.5" aria-hidden>
        {[70, 92, 55].map((w) => (
          <div key={w} className="h-2.5 rounded-full bg-surface-2 pulse-dot" style={{ width: `${w}%` }} />
        ))}
        <div className="h-24 rounded-lg bg-surface-2 pulse-dot" />
      </div>
    </div>
  );
}

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

/** An interactive block in a reply: a quiet card with a small toolbar, the frame, and an error line when it breaks. */
export function Widget({ title, source, stateKey, runId }: { title: string; source: string; stateKey: string; runId: string }) {
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
  const copySource = () =>
    void navigator.clipboard.writeText(source).then(
      () => toast("已复制源码"),
      () => toast("复制失败", "danger"),
    );
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
  const fix = () => host && void host.send(`刚才的「${label}」界面运行出错：${error}。请修复后重新给出这个界面。`);

  return (
    <div className="space-y-1.5">
      <div className="rounded-xl border border-line bg-surface">
        <div className="h-8 flex items-center gap-1.5 pl-3 pr-1 border-b border-line">
          <Sparkles className="size-3.5 shrink-0 text-muted" strokeWidth={1.8} />
          <span className="flex-1 min-w-0 truncate text-[12.5px] text-muted">{label}</span>
          <ToolButton label={code ? "看界面" : "看源码"} onClick={() => setCode((c) => !c)} active={code}>
            <Code2 className="size-3.5" strokeWidth={1.8} />
          </ToolButton>
          <ToolButton label="全屏" onClick={() => setFull(true)}>
            <Maximize2 className="size-3.5" strokeWidth={1.8} />
          </ToolButton>
          <Popover
            label="更多"
            side="bottom"
            className="w-48"
            triggerClassName="size-6 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 aria-expanded:bg-surface-2"
            trigger={<MoreHorizontal className="size-3.5" strokeWidth={1.8} />}
          >
            {(close) => (
              <div className="p-1.5">
                <MenuItem icon={<RotateCw className="size-4" strokeWidth={1.8} />} label="重新运行" onClick={() => { close(); reload(); }} />
                <MenuItem icon={<Copy className="size-4" strokeWidth={1.8} />} label="复制源码" onClick={() => { close(); copySource(); }} />
                {host && (
                  <>
                    <MenuDivider />
                    <MenuItem icon={<Save className="size-4" strokeWidth={1.8} />} label={saving ? "保存中…" : "另存为成果"} onClick={() => { close(); void saveArtifact(); }} />
                  </>
                )}
              </div>
            )}
          </Popover>
        </div>
        {code && <pre className="max-h-96 overflow-auto px-3.5 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all">{source}</pre>}
        <div className={cx("rounded-b-xl overflow-hidden", code && "hidden")}>
          <Frame key={gen} source={source} title={label} stateKey={stateKey} onError={onError} onReady={onReady} />
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 text-[13px] text-danger min-w-0">
          <CircleX className="size-3.5 shrink-0" strokeWidth={1.8} />
          <span className="truncate">界面出错：{error}</span>
          <span className="flex items-center gap-2 shrink-0 text-xs text-muted">
            <button className="hover:text-[var(--text)]" onClick={reload}>重试</button>
            {host && <button className="hover:text-[var(--text)]" onClick={fix}>让 agent 修复</button>}
          </span>
        </div>
      )}
      {full && (
        <FullScreen title={label} onClose={() => setFull(false)}>
          <Frame source={source} title={label} stateKey={stateKey} fill onError={onError} onReady={onReady} />
        </FullScreen>
      )}
    </div>
  );
}

function ToolButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cx("size-6 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2", active && "bg-surface-2 text-[var(--text)]")}>
      {children}
    </button>
  );
}

function FullScreen({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex-1 flex flex-col bg-surface sm:border border-line sm:rounded-2xl shadow-xl overflow-hidden safe-bottom">
        <div className="h-12 shrink-0 flex items-center gap-2 pl-4 pr-2 border-b border-line">
          <Sparkles className="size-4 text-muted" strokeWidth={1.8} />
          <div className="flex-1 min-w-0 truncate font-display font-semibold text-[15px]">{title}</div>
          <button aria-label="关闭" title="关闭" onClick={onClose} className="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2">
            <X className="size-4" strokeWidth={1.8} />
          </button>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </div>
  );
}
