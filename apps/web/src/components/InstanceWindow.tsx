import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hand, Loader2, Maximize2, PictureInPicture2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../lib/api";
import { closeInstanceWindow, useInstanceWindow } from "../lib/instanceWindow";
import { KIND_INFO, leaseText } from "../lib/instances";
import type { Agent, Desktop } from "../lib/types";
import { useVnc } from "../lib/vnc";
import { InstanceThumb } from "./InstanceThumb";
import { cx, toast } from "./ui";

const HEADER = 32;
const HEADER_BASE_LONG = 420;
const MARGIN = 8;
const GEO_KEY = "constella.instanceWindow.geo";

/** Where the window sits and how big its screen is (`long` = the screen's longer side, so portrait and landscape share one size). */
interface Geo {
  x: number;
  y: number;
  long: number;
}

function loadGeo(): Geo | null {
  try {
    const g = JSON.parse(localStorage.getItem(GEO_KEY) ?? "null") as Geo | null;
    return g && [g.x, g.y, g.long].every(Number.isFinite) ? g : null;
  } catch {
    return null;
  }
}

function saveGeo(g: Geo) {
  try {
    localStorage.setItem(GEO_KEY, JSON.stringify(g));
  } catch {
    // Not kept; the window opens at the default spot next time.
  }
}

function screenSize(d: Desktop, long: number): { w: number; h: number } {
  const android = d.kind === "android";
  const W = d.options.width ?? (android ? 720 : 1280);
  const H = d.options.height ?? (android ? 1280 : 800);
  return W >= H ? { w: long, h: Math.round((long * H) / W) } : { w: Math.round((long * W) / H), h: long };
}

/** The title bar scales with the screen so the outer floating window keeps one aspect ratio. */
function headerSize(long: number): number {
  return Math.max(1, Math.round((long * HEADER) / HEADER_BASE_LONG));
}

/** Keeps the window on screen: caps its size to the viewport, then its position. */
function clampGeo(d: Desktop, g: Geo): Geo {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const one = screenSize(d, 1000);
  const headerAt1000 = (1000 * HEADER) / HEADER_BASE_LONG;
  const maxLong = Math.floor(Math.min(((vw - 2 * MARGIN) * 1000) / one.w, ((vh - 2 * MARGIN) * 1000) / (one.h + headerAt1000)));
  const long = Math.max(Math.min(160, maxLong), Math.min(g.long, maxLong));
  const { w, h } = screenSize(d, long);
  const header = headerSize(long);
  return {
    long,
    x: Math.min(Math.max(MARGIN, g.x), vw - w - MARGIN),
    y: Math.min(Math.max(MARGIN, g.y), vh - h - header - MARGIN),
  };
}

function defaultGeo(d: Desktop): Geo {
  const long = window.innerWidth < 640 ? 260 : 420;
  const { w, h } = screenSize(d, long);
  // Bottom right, above a conversation's composer.
  return { long, x: window.innerWidth - w - 16, y: window.innerHeight - h - headerSize(long) - 140 };
}

const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled && "captureStream" in HTMLCanvasElement.prototype;

/**
 * A small floating window that watches an instance live from any page (opened from a conversation),
 * so you don't have to leave the conversation to see what the agent is doing. Hidden on that instance's own page.
 */
export function InstanceWindow() {
  const id = useInstanceWindow();
  const loc = useLocation();
  const list = useQuery({ queryKey: ["desktops"], queryFn: () => api.get<Desktop[]>("/api/desktops"), enabled: !!id, refetchInterval: 20_000 });
  const d = id ? list.data?.find((x) => x.id === id) : undefined;
  useEffect(() => {
    // Deleted while open.
    if (id && list.data && !d) closeInstanceWindow(id);
  }, [id, list.data, d]);
  if (!d || loc.pathname === `/instances/${d.id}`) return null;
  return <Window key={d.id} d={d} />;
}

function Window({ d }: { d: Desktop }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const screen = useRef<HTMLDivElement>(null);
  const running = d.state === "running";
  const { state, connect } = useVnc(d.id, running, screen);
  const [geo, setGeo] = useState<Geo>(() => clampGeo(d, loadGeo() ?? defaultGeo(d)));
  const [, relayout] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pip, setPip] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const on = () => relayout((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(
    () => () => {
      if (video.current && document.pictureInPictureElement === video.current) void document.exitPictureInPicture().catch(() => {});
    },
    [],
  );

  const g = clampGeo(d, geo);
  const { w, h } = screenSize(d, g.long);
  const header = headerSize(g.long);
  const headerScale = header / HEADER;
  // The resize grip sits on the corner facing the middle of the viewport, so there's always room to grow.
  const gripRight = g.x + w / 2 < window.innerWidth / 2;
  const gripBottom = g.y + (h + header) / 2 < window.innerHeight / 2;
  const Icon = KIND_INFO[d.kind].icon;
  const open = () => nav(`/instances/${d.id}`);

  /** Drags the window (header or screen) or resizes it (grip), keeping the corner opposite the grip in place. */
  const track = (e: ReactPointerEvent, mode: "move" | "resize") => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = g;
    const s0 = screenSize(d, start.long);
    const header0 = headerSize(start.long);
    const outerH0 = s0.h + header0;
    let last = start;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (mode === "move") last = clampGeo(d, { ...start, x: start.x + dx, y: start.y + dy });
      else {
        const scale = Math.max((s0.w + (gripRight ? dx : -dx)) / s0.w, (outerH0 + (gripBottom ? dy : -dy)) / outerH0);
        const long = clampGeo(d, { ...start, long: start.long * scale }).long;
        const s1 = screenSize(d, long);
        const outerH1 = s1.h + headerSize(long);
        last = clampGeo(d, {
          long,
          x: gripRight ? start.x : start.x + s0.w - s1.w,
          y: gripBottom ? start.y : start.y + outerH0 - outerH1,
        });
      }
      setGeo(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      saveGeo(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const takeover = async () => {
    setBusy(true);
    try {
      await api.post(`/api/desktops/${d.id}/takeover`);
      await qc.invalidateQueries({ queryKey: ["desktops"] });
      open();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  /** The browser's own picture-in-picture: stays on top even when you switch tabs or apps. */
  const popOut = async () => {
    const canvas = screen.current?.querySelector("canvas");
    if (!canvas) return;
    try {
      const v = video.current ?? document.createElement("video");
      video.current = v;
      v.muted = true;
      v.playsInline = true;
      const stream = canvas.captureStream();
      v.srcObject = stream;
      // The stream only carries a frame when the canvas changes, and a still screen never does: repaint it once in place
      // so the video gets its first frame (otherwise play() waits forever).
      canvas.getContext("2d")?.drawImage(canvas, 0, 0);
      (stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined)?.requestFrame?.();
      await v.play();
      await v.requestPictureInPicture();
      setPip(true);
      v.addEventListener(
        "leavepictureinpicture",
        () => {
          setPip(false);
          v.srcObject = null;
        },
        { once: true },
      );
    } catch (err) {
      toast(`没能打开系统小窗：${err instanceof Error ? err.message : String(err)}`, "danger");
    }
  };

  const status = !running
    ? d.state === "paused"
      ? "已暂停"
      : d.state === "starting"
        ? "启动中…"
        : "未运行"
    : state === "connecting"
      ? "连接中…"
      : state === "disconnected"
        ? "已断开"
        : leaseText(d, agents.data).text;

  return (
    <div
      role="dialog"
      aria-label={`${d.name} 小窗`}
      className="fixed z-40 rounded-xl border border-line bg-surface shadow-xl overflow-hidden select-none"
      style={{ left: g.x, top: g.y, width: w }}
    >
      <div style={{ height: header }} className="flex items-center overflow-hidden cursor-grab active:cursor-grabbing touch-none" onPointerDown={(e) => track(e, "move")} onDoubleClick={open}>
        <div
          className="h-8 flex-none items-center flex gap-1.5 pl-2.5 pr-1"
          style={{ width: `${100 / headerScale}%`, transform: `scale(${headerScale})`, transformOrigin: "left center" }}
        >
          <Icon className="size-3.5 text-muted shrink-0" />
          <div className="flex-1 min-w-0 truncate text-[12.5px]">
            <span className="font-medium">{d.name}</span>
            <span className="ml-1.5 text-muted">{status}</span>
          </div>
          {pipSupported && running && state === "connected" && !pip && (
            <WinButton label="系统小窗（切到别的标签页也能看）" onClick={() => void popOut()}>
              <PictureInPicture2 className="size-3.5" />
            </WinButton>
          )}
          {running && d.leaseInfo.holder !== "human" && (
            <WinButton label="接管" onClick={() => void takeover()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Hand className="size-3.5" />}
            </WinButton>
          )}
          <WinButton label="打开实例页" onClick={open}>
            <Maximize2 className="size-3.5" />
          </WinButton>
          <WinButton label="关闭小窗" onClick={() => closeInstanceWindow()}>
            <X className="size-3.5" />
          </WinButton>
        </div>
      </div>
      <div className="relative bg-[#0b0d18]" style={{ height: h }}>
        {running ? <div ref={screen} className="absolute inset-0" /> : <InstanceThumb d={d} width={480} className="absolute inset-0" />}
        {/* Above the (view-only) screen: drag to move, double-click to open the full page. */}
        <div className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" onPointerDown={(e) => track(e, "move")} onDoubleClick={open} />
        {running && state === "disconnected" && (
          <div className="absolute inset-0 grid place-items-center">
            <button type="button" onClick={() => void connect()} className="h-7 px-2.5 rounded-md bg-white/15 text-white text-xs hover:bg-white/25">
              重新连接
            </button>
          </div>
        )}
        {pip && (
          <div className="absolute inset-0 grid place-items-center bg-[#0b0d18]/85 text-white text-xs">
            <div className="text-center space-y-2">
              <div className="opacity-80">正在系统小窗里显示</div>
              <button type="button" onClick={() => void document.exitPictureInPicture().catch(() => {})} className="h-7 px-2.5 rounded-md bg-white/15 hover:bg-white/25">
                收回
              </button>
            </div>
          </div>
        )}
        <div
          aria-hidden
          className={cx("absolute size-5 touch-none", gripRight ? "right-0" : "left-0", gripBottom ? "bottom-0" : "top-0", gripRight === gripBottom ? "cursor-nwse-resize" : "cursor-nesw-resize")}
          onPointerDown={(e) => track(e, "resize")}
        >
          <span className={cx("absolute size-2.5 border-white/60", gripRight ? "right-1 border-r-2" : "left-1 border-l-2", gripBottom ? "bottom-1 border-b-2" : "top-1 border-t-2")} />
        </div>
      </div>
    </div>
  );
}

function WinButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="size-6 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 shrink-0">
      {children}
    </button>
  );
}
