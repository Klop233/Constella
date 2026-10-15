import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CompileError, compileTolerant, compileWidget, dropRoots, rootsOf } from "../../lib/genui/compile";
import { repairPartial } from "../../lib/genui/repair";
import { BRIDGE, frameSrcdoc } from "../../lib/genui/runtime";
import { toast } from "../ui";
import type { Ctx, Node } from "./components";
import { renderTree } from "./Renderer";

// One component block: compiles the program (also while it streams in, from the part written so
// far), runs it in a hidden sandboxed frame, and renders the trees it posts with native components.
// Local interactions (sliders, tabs, inputs) are handled by the program without the agent; only
// send() reaches the agent, as a new message from the owner.

export interface BlockHost {
  send: (text: string) => void;
  /** Saved hook state, or undefined while loading. */
  slots: unknown[] | undefined | null;
  saveSlots: (slots: unknown[]) => void;
}

const WATCHDOG_MS = 3000;
const STREAM_COMPILE_MS = 250;
let srcdoc: string | null = null;

export interface BlockState {
  error: string | null;
  /** Roots skipped because they were broken; the rest shows. */
  dropped: number;
  /** True once a tree has been shown. */
  shown: boolean;
}

export function GenUIBlock({ source, streaming, host, onState, reloadKey }: { source: string; streaming: boolean; host: BlockHost; onState?: (s: BlockState) => void; reloadKey?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [tree, setTree] = useState<Node | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const ready = useRef(false);
  const queued = useRef<{ code: string } | null>(null);
  const lastCode = useRef("");
  const watchdog = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSend = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  srcdoc ??= frameSrcdoc();

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
      post({ type: "load", code, slots: host.slots ?? [] });
    },
    [post, host.slots],
  );

  // Compile: the finished block as written (skipping roots that don't compile); while streaming,
  // the part written so far (repaired).
  const [dropped, setDropped] = useState(0);
  const degrade = useRef<{ base: Set<number>; next: number } | null>(null);
  useEffect(() => {
    if (host.slots === undefined) return; // wait for saved state
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
      try {
        const c = await compileTolerant(source);
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
  }, [source, streaming, load, host.slots]);

  /** The finished block failed while rendering: try it without one root at a time, last first. */
  const tryWithoutARoot = useCallback(async () => {
    const roots = rootsOf(source);
    const d = (degrade.current ??= { base: new Set(), next: roots.length - 1 });
    while (d.next >= 0) {
      const k = d.next--;
      try {
        const { code } = await compileWidget(dropRoots(source, new Set([...d.base, k])));
        setDropped(1);
        load(code);
        return true;
      } catch {
        // that variant doesn't compile either; try the next
      }
    }
    return false;
  }, [source, load]);
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
            post({ type: "load", code: queued.current.code, slots: host.slots ?? [] });
            queued.current = null;
          }
          break;
        case "idle":
          clearTimeout(watchdog.current);
          break;
        case "tree":
          setTree((m.tree as Node) ?? null);
          shownCode.current = lastCode.current;
          if (!streamingRef.current && !degrade.current) setError(null);
          break;
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
            clearTimeout(saveTimer.current);
            const slots = m.slots;
            saveTimer.current = setTimeout(() => host.saveSlots(slots), 500);
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
  }, [host, post, tryWithoutARoot]);

  useEffect(
    () => () => {
      clearTimeout(watchdog.current);
      clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => onState?.({ error, dropped, shown: !!tree }), [error, dropped, tree, onState]);

  // "Run again": a fresh frame, keeping the state.
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!reloadKey) return;
    ready.current = false;
    queued.current = lastCode.current ? { code: lastCode.current } : null;
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
  const content: ReactNode = tree ? renderTree(tree, call, ctx) : null;
  const roots = tree && tree.t === "Fragment" ? tree.c : null;

  return (
    <>
      {!dead && <iframe key={gen} ref={frame} title="界面运行环境" sandbox="allow-scripts" srcDoc={srcdoc} className="hidden" aria-hidden tabIndex={-1} />}
      {tree ? (
        <div className="genui min-w-0 flex flex-col gap-3 font-display">{roots ? roots.map((n, i) => <RootItem key={i} node={n} call={call} ctx={ctx} />) : content}</div>
      ) : !error ? (
        <div className="flex items-center gap-2 h-10 text-[13px] text-muted">
          <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={1.8} />
          正在生成界面…
        </div>
      ) : null}
    </>
  );
}

function RootItem({ node, call, ctx }: { node: Node | string; call: (id: number, args: unknown[]) => void; ctx: Ctx }) {
  return <>{renderTree(node, call, ctx)}</>;
}
