import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompileError, compileTolerant, compileWidget, dropRoots, rootsOf } from "../../lib/genui/compile";
import { repairPartial } from "../../lib/genui/repair";
import { BRIDGE, frameSrcdoc } from "../../lib/genui/runtime";
import { toast } from "../ui";
import type { Ctx, Node } from "./components";
import { renderTree } from "./Renderer";
import { validateTree } from "./validate";

// One component block: compiles the program (also while it streams in, from the part written so
// far), runs it in a hidden sandboxed frame, validates the trees it posts against the component
// schema and renders them with native components. Local interactions (sliders, tabs, inputs) are
// handled by the program without the agent; only send() reaches the agent, as a new message.
//
// The runtime starts only when the block comes near the viewport. Until then a block that has run
// before shows its last tree (saved with its state), so a long conversation doesn't start dozens
// of workers at once and doesn't flash "正在生成界面…".

/** What a block keeps between visits: its hook state and the last tree it showed. */
export interface Saved {
  slots?: unknown[];
  tree?: Node;
}

export interface BlockHost {
  send: (text: string) => void;
  /** Saved state; undefined while loading, null when there is none. */
  saved: Saved | undefined | null;
  save: (data: Saved) => void;
}

/** streaming: still being written · final: complete · interrupted: the reply ended mid-block. */
export type BlockMode = "streaming" | "final" | "interrupted";

export interface BlockState {
  error: string | null;
  /** Roots skipped because they were broken; the rest shows. */
  dropped: number;
  /** Props or components the validator had to drop or flag. */
  diagnostics: string[];
  /** True once a tree has been shown. */
  shown: boolean;
}

const WATCHDOG_MS = 3000;
const STREAM_COMPILE_MS = 250;
const SNAPSHOT_MAX = 48 * 1024;
let srcdoc: string | null = null;

export function GenUIBlock({ source, mode, host, onState, reloadKey, eager }: { source: string; mode: BlockMode; host: BlockHost; onState?: (s: BlockState) => void; reloadKey?: number; eager?: boolean }) {
  const streaming = mode === "streaming";
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [tree, setTree] = useState<Node | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const [active, setActive] = useState(!!eager || streaming);
  const ready = useRef(false);
  const queued = useRef<{ code: string } | null>(null);
  const lastCode = useRef("");
  const watchdog = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSend = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  srcdoc ??= frameSrcdoc();
  const slots = host.saved === undefined ? undefined : (host.saved?.slots ?? []);

  // Start the runtime when the block comes near the viewport (streaming blocks start right away).
  useEffect(() => {
    if (active || !box.current) return;
    if (streaming) return setActive(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setActive(true), { rootMargin: "800px 0px" });
    io.observe(box.current);
    return () => io.disconnect();
  }, [active, streaming]);

  const post = useCallback((m: Record<string, unknown>) => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    w.postMessage({ [BRIDGE]: 1, ...m }, "*");
    clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      setDead(true);
      setError("界面运行卡住了，已停止");
    }, WATCHDOG_MS);
  }, []);

  const load = useCallback(
    (code: string) => {
      if (code === lastCode.current) return;
      lastCode.current = code;
      if (!ready.current) {
        queued.current = { code };
        return;
      }
      post({ type: "load", code, slots: slots ?? [] });
    },
    [post, slots],
  );

  // Keep state and the last tree (for the snapshot), written at most twice a second and only when changed.
  const latest = useRef<Saved>({});
  const savedJson = useRef<string>("");
  useEffect(() => {
    if (host.saved !== undefined && !savedJson.current) savedJson.current = JSON.stringify(host.saved ?? {});
  }, [host.saved]);
  const scheduleSave = useCallback(() => {
    if (streamingRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const data: Saved = { slots: latest.current.slots ?? slots ?? [] };
      if (latest.current.tree && JSON.stringify(latest.current.tree).length <= SNAPSHOT_MAX) data.tree = latest.current.tree;
      const json = JSON.stringify(data);
      if (json === savedJson.current) return;
      savedJson.current = json;
      host.save(data);
    }, 500);
  }, [host, slots]);

  // Compile: the finished block as written (skipping roots that don't compile); while streaming or
  // after an interrupted reply, the part written so far (repaired).
  const [dropped, setDropped] = useState(0);
  const degrade = useRef<{ next: number } | null>(null);
  useEffect(() => {
    if (!active || slots === undefined) return;
    let cancelled = false;
    const run = async () => {
      if (streaming) {
        const text = repairPartial(source);
        if (!text) return;
        try {
          const { code } = await compileWidget(text);
          if (!cancelled) load(code);
        } catch {
          // half-written code is expected to fail now and then
        }
        return;
      }
      const text = mode === "interrupted" ? repairPartial(source) : source;
      if (!text) {
        setError("回答在界面开始之前就中断了");
        return;
      }
      try {
        const c = await compileTolerant(text);
        if (cancelled) return;
        setDropped(c.dropped);
        setError(c.dropped ? c.error : null);
        degrade.current = null;
        load(c.code);
      } catch (err) {
        if (!cancelled) setError(err instanceof CompileError ? `代码有误：${err.message}` : String(err));
      }
    };
    const t = setTimeout(run, streaming ? STREAM_COMPILE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `slots` only gates the first load; later saves must not recompile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mode, active, slots === undefined, load]);

  /** The finished block failed while rendering: try it without one root at a time, last first. */
  const tryWithoutARoot = useCallback(async () => {
    const text = (mode === "interrupted" ? repairPartial(source) : source) ?? source;
    const roots = rootsOf(text);
    const d = (degrade.current ??= { next: roots.length - 1 });
    while (d.next >= 0) {
      const k = d.next--;
      try {
        const { code } = await compileWidget(dropRoots(text, new Set([k])));
        setDropped(1);
        load(code);
        return;
      } catch {
        // that variant doesn't compile either; try the next
      }
    }
  }, [source, mode, load]);
  const shownCode = useRef("");

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || !(BRIDGE in m)) return;
      switch (m.type) {
        case "ready":
          ready.current = true;
          if (queued.current) {
            post({ type: "load", code: queued.current.code, slots: slots ?? [] });
            queued.current = null;
          }
          break;
        case "idle":
          clearTimeout(watchdog.current);
          break;
        case "tree": {
          const v = validateTree(m.tree);
          setTree(v.tree as Node | null);
          if (!streamingRef.current) setDiagnostics(v.diagnostics);
          shownCode.current = lastCode.current;
          if (!streamingRef.current && !degrade.current) setError((e) => (e?.startsWith("代码有误") ? e : null));
          latest.current.tree = m.tree as Node;
          scheduleSave();
          break;
        }
        case "error": {
          const message = String(m.message ?? "未知错误");
          // While streaming, a render error usually means the tree isn't complete yet.
          if (streamingRef.current && m.phase !== "event" && m.phase !== "async") break;
          setError(message);
          // The finished program never rendered: show what does work, without the broken part.
          if (!streamingRef.current && (m.phase === "render" || m.phase === "load") && shownCode.current !== lastCode.current) void tryWithoutARoot();
          break;
        }
        case "state":
          if (Array.isArray(m.slots)) {
            latest.current.slots = m.slots;
            scheduleSave();
          }
          break;
        case "send": {
          const text = String(m.text ?? "").trim();
          // Only right after the owner's own click or key press, and not twice in a row.
          if (!text || (navigator.userActivation && !navigator.userActivation.isActive)) break;
          if (Date.now() - lastSend.current < 2000) break;
          lastSend.current = Date.now();
          host.send(text);
          break;
        }
        case "copy":
          void navigator.clipboard.writeText(String(m.text ?? "")).then(() => toast("已复制"), () => toast("复制失败", "danger"));
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
  }, [host, post, tryWithoutARoot, scheduleSave, slots]);

  useEffect(
    () => () => {
      clearTimeout(watchdog.current);
      clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => onState?.({ error, dropped, diagnostics, shown: !!tree }), [error, dropped, diagnostics, tree, onState]);

  // "Run again": a fresh frame, keeping the state.
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!reloadKey) return;
    ready.current = false;
    queued.current = lastCode.current ? { code: lastCode.current } : null;
    setActive(true);
    setDead(false);
    setError(null);
    setGen((g) => g + 1);
  }, [reloadKey]);

  const ctx = useMemo<Ctx>(
    () => ({
      send: (text) => {
        if (Date.now() - lastSend.current < 1500) return;
        lastSend.current = Date.now();
        host.send(text);
      },
      copy: (text) => void navigator.clipboard.writeText(text).then(() => toast("已复制"), () => toast("复制失败", "danger")),
      open: (url) => /^https?:\/\//i.test(url) && window.open(url, "_blank", "noopener,noreferrer"),
    }),
    [host],
  );
  const call = useCallback((id: number, args: unknown[]) => !dead && post({ type: "call", id, args }), [dead, post]);
  // Until the runtime has rendered, the saved tree stands in (validated the same way, not interactive).
  const snapshot = useMemo(() => (!tree && host.saved?.tree ? (validateTree(host.saved.tree).tree as Node | null) : null), [tree, host.saved]);
  const shown = tree ?? snapshot;
  const roots = shown && shown.t === "Fragment" ? shown.c : shown ? [shown] : null;
  const noop = useCallback(() => {}, []);

  return (
    <div ref={box} className="min-w-0">
      {active && !dead && <iframe key={gen} ref={frame} title="界面运行环境" sandbox="allow-scripts" srcDoc={srcdoc} className="hidden" aria-hidden tabIndex={-1} />}
      {roots ? (
        <div className="genui min-w-0 flex flex-col gap-3 font-display">
          {roots.map((n, i) => (
            <RootItem key={i} node={n} call={tree ? call : noop} ctx={ctx} />
          ))}
        </div>
      ) : !error && !active ? (
        <div className="h-24 rounded-xl bg-surface-2/60" aria-hidden />
      ) : !error ? (
        <div className="flex items-center gap-2 h-10 text-[13px] text-muted">
          <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={1.8} />
          正在生成界面…
        </div>
      ) : null}
    </div>
  );
}

/** One top-level item; bare text and unknown components' content become their own paragraph. */
function RootItem({ node, call, ctx }: { node: Node | string; call: (id: number, args: unknown[]) => void; ctx: Ctx }) {
  const inline = typeof node === "string" || node.t === "Fragment" || node.t === "Step" || node.t === "Tab" || node.t === "Event";
  return inline ? <div className="min-w-0 text-sm leading-relaxed">{renderTree(node, call, ctx)}</div> : <>{renderTree(node, call, ctx)}</>;
}
