import RFB from "@novnc/novnc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ClipboardPaste, Hand, Keyboard, Maximize, MoreVertical, Play, Power, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Field, Sheet, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import type { Agent, Desktop } from "../lib/types";
import { leaseText } from "./Desktops";

const XK: Record<string, number> = {
  Escape: 0xff1b,
  Tab: 0xff09,
  BackSpace: 0xff08,
  Return: 0xff0d,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
  Delete: 0xffff,
};

function keysymFor(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (ch === "\n") return XK.Return!;
  return code < 0x100 ? code : 0x01000000 + code;
}

export default function DesktopView() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const screen = useRef<HTMLDivElement>(null);
  const kbd = useRef<HTMLTextAreaElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [connState, setConnState] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [fit, setFit] = useState(true);
  const [ctrl, setCtrl] = useState(false);
  const [menu, setMenu] = useState(false);
  const [handback, setHandback] = useState(false);
  const [note, setNote] = useState("");
  const [paste, setPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);

  const desktop = useQuery({
    queryKey: ["desktops", id],
    queryFn: async () => (await api.get<Desktop[]>("/api/desktops")).find((d) => d.id === id) ?? null,
    refetchInterval: 10_000,
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const d = desktop.data;
  const mine = d?.leaseInfo.holder === "human";
  const running = d?.state === "running";

  const connect = useCallback(async () => {
    if (!screen.current || !id) return;
    rfb.current?.disconnect();
    setConnState("connecting");
    try {
      const { ticket } = await api.post<{ ticket: string }>(`/api/desktops/${id}/ticket`);
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(screen.current, `${proto}://${location.host}/api/desktops/${id}/vnc?ticket=${encodeURIComponent(ticket)}`, { shared: true });
      r.scaleViewport = true;
      r.resizeSession = false;
      r.viewOnly = true;
      r.background = "#0b0d18";
      r.addEventListener("connect", () => setConnState("connected"));
      r.addEventListener("disconnect", () => setConnState("disconnected"));
      rfb.current = r;
    } catch (err) {
      setConnState("disconnected");
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  }, [id]);

  useEffect(() => {
    if (running) void connect();
    return () => {
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [running, connect]);

  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = !mine;
  }, [mine, connState]);

  useEffect(() => {
    if (!rfb.current) return;
    rfb.current.scaleViewport = fit;
    rfb.current.clipViewport = !fit;
    rfb.current.dragViewport = !fit && !mine;
  }, [fit, mine, connState]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["desktops"] });
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  const sendKey = (sym: number, code?: string) => {
    const r = rfb.current;
    if (!r || !mine) return;
    if (ctrl) r.sendKey(XK.Control_L!, "ControlLeft", true);
    r.sendKey(sym, code ?? null);
    if (ctrl) {
      r.sendKey(XK.Control_L!, "ControlLeft", false);
      setCtrl(false);
    }
  };

  const l = d ? leaseText(d, agents.data) : null;

  return (
    <div className="fixed inset-0 lg:left-60 bg-[#0b0d18] text-white flex flex-col">
      <div className="safe-top bg-black/60 backdrop-blur z-10">
        <div className="h-12 flex items-center gap-1 px-1">
          <button aria-label="返回" className="size-10 grid place-items-center" onClick={() => nav(-1)}>
            <ChevronLeft className="size-6" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{d?.name ?? "桌面"}</div>
            <div className="text-[11px] opacity-70 truncate">
              {l?.text}
              {connState === "connecting" && running && " · 连接中…"}
              {connState === "disconnected" && running && " · 已断开"}
            </div>
          </div>
          {running && !mine && (
            <Button size="sm" variant="primary" loading={busy} onClick={() => act(() => api.post(`/api/desktops/${id}/takeover`), "已接管，agent 暂停操作")}>
              <Hand className="size-4" /> 接管
            </Button>
          )}
          {mine && (
            <Button size="sm" variant="primary" onClick={() => setHandback(true)}>
              <Undo2 className="size-4" /> 交还
            </Button>
          )}
          <button aria-label="更多" className="size-10 grid place-items-center" onClick={() => setMenu(true)}>
            <MoreVertical className="size-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {running ? (
          <div ref={screen} className="absolute inset-0" />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center space-y-3">
              <div className="opacity-70 text-sm">{desktop.isLoading ? "加载中…" : "桌面未运行"}</div>
              {!desktop.isLoading && (
                <Button variant="primary" loading={busy} onClick={() => act(() => api.post(`/api/desktops/${id}/start`), "已启动")}>
                  <Play className="size-4" /> 启动桌面
                </Button>
              )}
            </div>
          </div>
        )}
        {running && connState === "disconnected" && (
          <div className="absolute inset-x-0 bottom-6 flex justify-center">
            <Button variant="secondary" onClick={() => connect()}>
              重新连接
            </Button>
          </div>
        )}
        {running && !mine && d?.leaseInfo.holder === "agent" && (
          <div className="absolute top-2 inset-x-2 text-center text-xs bg-black/55 rounded-xl px-3 py-2">agent 正在操作，你在旁观。需要你登录或输入验证码时点「接管」。</div>
        )}
      </div>

      {mine && (
        <div className="bg-black/70 safe-bottom">
          <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto no-scrollbar text-sm">
            <ToolKey label="键盘" onClick={() => kbd.current?.focus()}>
              <Keyboard className="size-4" />
            </ToolKey>
            <ToolKey label="Ctrl" active={ctrl} onClick={() => setCtrl(!ctrl)}>
              Ctrl
            </ToolKey>
            {(["Escape", "Tab", "Return", "BackSpace", "Left", "Up", "Down", "Right"] as const).map((k) => (
              <ToolKey key={k} label={k} onClick={() => sendKey(XK[k]!)}>
                {{ Escape: "Esc", Tab: "Tab", Return: "↵", BackSpace: "⌫", Left: "←", Up: "↑", Down: "↓", Right: "→" }[k]}
              </ToolKey>
            ))}
            <ToolKey label="粘贴文字" onClick={() => setPaste(true)}>
              <ClipboardPaste className="size-4" />
            </ToolKey>
          </div>
          <textarea
            ref={kbd}
            aria-label="键盘输入"
            className="absolute opacity-0 pointer-events-none h-0 w-0"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onInput={(e) => {
              const v = e.currentTarget.value;
              for (const ch of v) sendKey(keysymFor(ch));
              e.currentTarget.value = "";
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace") {
                e.preventDefault();
                sendKey(XK.BackSpace!);
              } else if (e.key === "Enter") {
                e.preventDefault();
                sendKey(XK.Return!);
              }
            }}
          />
        </div>
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} title={d?.name ?? "桌面"}>
        <div className="space-y-2 text-[var(--text)]">
          <Button className="w-full" onClick={() => (setFit(!fit), setMenu(false))}>
            <Maximize className="size-4" /> {fit ? "原始大小（拖动查看）" : "适应屏幕"}
          </Button>
          <div className="text-xs text-muted px-1">提示：横屏查看更清楚。接管后：单指点击＝左键，双指点击＝右键，双指拖动＝滚动。</div>
          {running && d?.leaseInfo.holder === "none" && (
            <Button className="w-full" onClick={() => act(() => api.post(`/api/desktops/${id}/stop`), "已停止").then(() => setMenu(false))}>
              <Power className="size-4" /> 停止桌面
            </Button>
          )}
          <Button
            variant="danger"
            className="w-full"
            onClick={() => {
              if (!confirm("删除这台桌面？里面的浏览器登录状态和文件会一并删除。")) return;
              void act(() => api.del(`/api/desktops/${id}`), "已删除").then(() => nav("/desktops", { replace: true }));
            }}
          >
            删除桌面
          </Button>
        </div>
      </Sheet>

      <Sheet open={handback} onClose={() => setHandback(false)} title="交还给 agent">
        <div className="space-y-4 text-[var(--text)]">
          <Field label="给 agent 留句话（可选）" hint="例如：已登录 / 验证码已填好 / 不要点支付">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </Field>
          <Button
            variant="primary"
            className="w-full"
            loading={busy}
            onClick={() =>
              act(() => api.post(`/api/desktops/${id}/handback`, { note }), "已交还").then(() => {
                setHandback(false);
                setNote("");
              })
            }
          >
            交还
          </Button>
        </div>
      </Sheet>

      <Sheet open={paste} onClose={() => setPaste(false)} title="粘贴文字到桌面">
        <div className="space-y-4 text-[var(--text)]">
          <textarea className={cx(inputClass, "min-h-32")} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="内容会放进桌面剪贴板并按 Ctrl+V" />
          <Button
            variant="primary"
            className="w-full"
            onClick={() =>
              act(async () => {
                await api.post(`/api/desktops/${id}/clipboard`, { text: pasteText });
                const r = rfb.current;
                if (r) {
                  r.sendKey(XK.Control_L!, "ControlLeft", true);
                  r.sendKey(0x76, "KeyV");
                  r.sendKey(XK.Control_L!, "ControlLeft", false);
                }
              }, "已粘贴").then(() => {
                setPaste(false);
                setPasteText("");
              })
            }
          >
            粘贴
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function ToolKey({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx("h-9 min-w-10 px-2.5 rounded-lg grid place-items-center shrink-0", active ? "bg-accent" : "bg-white/10 active:bg-white/20")}
    >
      {children}
    </button>
  );
}
