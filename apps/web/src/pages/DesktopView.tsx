import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronLeft, ClipboardPaste, Hand, Keyboard, Maximize, MoreVertical, Pause, Play, Power, RotateCcw, Settings2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { InstanceFields, type InstanceDraft } from "../components/InstanceFields";
import { PerfChart, compactBytes, compactCores, compactRate, type PerfSeriesDef } from "../components/PerfChart";
import { Button, Empty, Field, Loading, Segmented, Sheet, StatTile, cx, inputClass, toast } from "../components/ui";
import { api } from "../lib/api";
import { KIND_INFO, leaseText } from "../lib/instances";
import { RANGES, ROLE_LABEL, bytes, cores, rate, type InstancePerf, type PerfPoint, type PerfRange } from "../lib/perf";
import type { Agent, Desktop, HostCaps } from "../lib/types";
import { useVnc } from "../lib/vnc";

const PERF_METRICS: { value: "cpu" | "mem" | "net"; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "mem", label: "内存" },
  { value: "net", label: "网络" },
];

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
  const [fit, setFit] = useState(true);
  const [ctrl, setCtrl] = useState(false);
  const [menu, setMenu] = useState(false);
  const [handback, setHandback] = useState(false);
  const [note, setNote] = useState("");
  const [paste, setPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<InstanceDraft | null>(null);
  const [gsf, setGsf] = useState<string | null>(null);
  const [perfOpen, setPerfOpen] = useState(false);
  const [perfRange, setPerfRange] = useState<PerfRange>("1h");
  const [perfMetric, setPerfMetric] = useState<"cpu" | "mem" | "net">("cpu");
  const resuming = useRef(false);

  const desktop = useQuery({
    queryKey: ["desktops", id],
    queryFn: async () => (await api.get<Desktop[]>("/api/desktops")).find((d) => d.id === id) ?? null,
    refetchInterval: 10_000,
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const caps = useQuery({ queryKey: ["hostcaps"], queryFn: () => api.get<HostCaps>("/api/desktops/capabilities"), enabled: !!editing });
  // This instance's own containers, sampled by the hub; only while the panel is open.
  const perf = useQuery({
    queryKey: ["desktop-perf", id, perfRange],
    queryFn: () => api.get<InstancePerf>(`/api/desktops/${id}/perf?range=${perfRange}`),
    enabled: perfOpen && !!id,
    refetchInterval: 10_000,
  });
  const d = desktop.data;
  const mine = d?.leaseInfo.holder === "human";
  const running = d?.state === "running";
  const android = d?.kind === "android";

  const { rfb, state: connState, connect } = useVnc(id, running, screen);

  // Opening a paused instance thaws it: the screen should be live while someone looks at it.
  useEffect(() => {
    if (d?.state !== "paused" || resuming.current) return;
    resuming.current = true;
    void api
      .post(`/api/desktops/${id}/resume`)
      .then(() => qc.invalidateQueries({ queryKey: ["desktops"] }))
      .catch((err) => toast(err instanceof Error ? err.message : String(err), "danger"))
      .finally(() => (resuming.current = false));
  }, [d?.state, id, qc]);

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
  const pg = perf.data?.group ?? null;
  const pNow = pg?.now ?? null;
  const pHistory = pg?.history ?? [];
  const pSeries: { format: (v: number) => string; tickFormat: (v: number) => string; max?: number; series: PerfSeriesDef[] } =
    perfMetric === "cpu"
      ? { format: cores, tickFormat: compactCores, max: perf.data?.cores ?? undefined, series: [{ name: "使用", value: (p: PerfPoint) => p.cpu }] }
      : perfMetric === "mem"
        ? { format: bytes, tickFormat: compactBytes, series: [{ name: "已用", value: (p: PerfPoint) => p.mem }] }
        : {
            format: rate,
            tickFormat: compactRate,
            series: [
              { name: "下行", value: (p: PerfPoint) => p.rx, color: "var(--series-1)" },
              { name: "上行", value: (p: PerfPoint) => p.tx, color: "var(--series-2)" },
            ],
          };

  /** Android: text goes in through the device's input method (any language), not as VNC key presses. */
  const typeText = (text: string) => {
    if (!text) return;
    api.post(`/api/desktops/${id}/clipboard`, { text }).catch((err) => toast(err instanceof Error ? err.message : String(err), "danger"));
  };
  const androidKey = (keys: string) => {
    api.post(`/api/desktops/${id}/action`, { type: "key", keys }).catch((err) => toast(err instanceof Error ? err.message : String(err), "danger"));
  };
  const openSettings = () => {
    if (!d) return;
    setEditing({ name: d.name, kind: d.kind, options: d.options, agentIds: d.agentIds });
    setMenu(false);
  };
  const saveSettings = async (confirmDataLoss = false) => {
    if (!editing || !d) return;
    try {
      setBusy(true);
      const r = await api.patch<{ restarted: boolean; wiped: boolean }>(`/api/desktops/${id}`, {
        name: editing.name.trim() || d.name,
        options: editing.options,
        agentIds: editing.agentIds,
        confirmDataLoss,
      });
      toast(r.restarted ? "已保存，实例已重启" : "已保存");
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["desktops"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "confirm" && confirm(`${e.message}。继续吗？`)) return saveSettings(true);
      toast(e.message ?? String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 lg:left-64 bg-[#0b0d18] text-white flex flex-col">
      <div className="safe-top bg-black/60 backdrop-blur z-10">
        <div className="h-12 flex items-center gap-1 px-1">
          <button aria-label="返回" className="size-10 grid place-items-center" onClick={() => nav(-1)}>
            <ChevronLeft className="size-6" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {d?.name ?? "实例"}
              {d && <span className="ml-1.5 text-[11px] font-normal opacity-70">{KIND_INFO[d.kind].label}</span>}
            </div>
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
              <div className="opacity-70 text-sm">{desktop.isLoading ? "加载中…" : d?.state === "paused" ? "正在恢复…" : d?.state === "starting" ? "正在启动…" : "实例未运行"}</div>
              {!desktop.isLoading && d?.state !== "paused" && (
                <Button variant="primary" loading={busy} onClick={() => act(() => api.post(`/api/desktops/${id}/start`), "已启动")}>
                  <Play className="size-4" /> 启动{android ? "（安卓需要一两分钟）" : ""}
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
          <div className="absolute top-2 inset-x-2 text-center text-xs bg-black/55 rounded-xl px-3 py-2">agent 正在操作，你在旁观。需要你登录、输入验证码或扫码时点「接管」。</div>
        )}
      </div>

      {mine && (
        <div className="bg-black/70 safe-bottom">
          <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto no-scrollbar text-sm">
            <ToolKey label="键盘" onClick={() => kbd.current?.focus()}>
              <Keyboard className="size-4" />
            </ToolKey>
            {android ? (
              (
                [
                  ["back", "返回", "◁"],
                  ["home", "主页", "○"],
                  ["recents", "多任务", "□"],
                  ["enter", "回车", "↵"],
                  ["backspace", "删除", "⌫"],
                ] as const
              ).map(([k, label, glyph]) => (
                <ToolKey key={k} label={label} onClick={() => androidKey(k)}>
                  {glyph}
                </ToolKey>
              ))
            ) : (
              <>
                <ToolKey label="Ctrl" active={ctrl} onClick={() => setCtrl(!ctrl)}>
                  Ctrl
                </ToolKey>
                {(["Escape", "Tab", "Return", "BackSpace", "Left", "Up", "Down", "Right"] as const).map((k) => (
                  <ToolKey key={k} label={k} onClick={() => sendKey(XK[k]!)}>
                    {{ Escape: "Esc", Tab: "Tab", Return: "↵", BackSpace: "⌫", Left: "←", Up: "↑", Down: "↓", Right: "→" }[k]}
                  </ToolKey>
                ))}
              </>
            )}
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
              // Wait for the input method to finish composing (Chinese etc.) before sending.
              if ((e.nativeEvent as InputEvent).isComposing) return;
              const v = e.currentTarget.value;
              if (android) typeText(v);
              else for (const ch of v) sendKey(keysymFor(ch));
              e.currentTarget.value = "";
            }}
            onCompositionEnd={(e) => {
              const v = e.currentTarget.value;
              if (android) typeText(v);
              else for (const ch of v) sendKey(keysymFor(ch));
              e.currentTarget.value = "";
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Backspace") {
                e.preventDefault();
                if (android) androidKey("backspace");
                else sendKey(XK.BackSpace!);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (android) androidKey("enter");
                else sendKey(XK.Return!);
              }
            }}
          />
        </div>
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} title={d?.name ?? "实例"}>
        <div className="space-y-2 text-[var(--text)]">
          <Button className="w-full" onClick={() => (setFit(!fit), setMenu(false))}>
            <Maximize className="size-4" /> {fit ? "原始大小（拖动查看）" : "适应屏幕"}
          </Button>
          <div className="text-xs text-muted px-1">
            {android
              ? "接管后：点击＝点按，拖动＝滑动，右键＝返回；输入中文用「键盘」或「粘贴文字」。"
              : "提示：横屏查看更清楚。接管后：单指点击＝左键，双指点击＝右键，双指拖动＝滚动。"}
          </div>
          <Button className="w-full" onClick={openSettings}>
            <Settings2 className="size-4" /> 实例设置
          </Button>
          <Button className="w-full" onClick={() => (setMenu(false), setPerfOpen(true))}>
            <Activity className="size-4" /> 性能
          </Button>
          {android && d?.options.googlePlay && running && (
            <Button
              className="w-full"
              onClick={() =>
                act(async () => {
                  const r = await api.get<{ id: string | null; error?: string }>(`/api/desktops/${id}/android/gsf-id`);
                  if (!r.id) throw new Error(r.error ?? "还没有生成设备 ID，打开一次 Play 商店后再试");
                  setGsf(r.id);
                })
              }
            >
              Google 设备登记
            </Button>
          )}
          {running && d?.leaseInfo.holder === "none" && (
            <Button className="w-full" onClick={() => act(() => api.post(`/api/desktops/${id}/pause`), "已暂停").then(() => setMenu(false))}>
              <Pause className="size-4" /> 暂停（保留内存）
            </Button>
          )}
          {(running || d?.state === "paused") && (
            <Button
              className="w-full"
              onClick={() => {
                if (d?.leaseInfo.holder === "agent" && !confirm("agent 正在使用这个实例，重启会打断它的操作。继续吗？")) return;
                void act(() => api.post(`/api/desktops/${id}/restart`), "已重启").then(() => setMenu(false));
              }}
            >
              <RotateCcw className="size-4" /> 重启
            </Button>
          )}
          {(running || d?.state === "paused") && d?.leaseInfo.holder === "none" && (
            <Button className="w-full" onClick={() => act(() => api.post(`/api/desktops/${id}/stop`), "已停止").then(() => setMenu(false))}>
              <Power className="size-4" /> 停止
            </Button>
          )}
          <Button
            variant="danger"
            className="w-full"
            onClick={() => {
              if (!confirm(`删除「${d?.name ?? ""}」？里面的${android ? "App 和数据" : "浏览器登录状态和文件"}会一并删除，分给它的 agent 也会解除绑定。`)) return;
              void act(() => api.del(`/api/desktops/${id}`), "已删除").then(() => nav("/desktops", { replace: true }));
            }}
          >
            删除
          </Button>
        </div>
      </Sheet>

      <Sheet open={perfOpen} onClose={() => setPerfOpen(false)} title={`性能 · ${d?.name ?? "实例"}`}>
        <div className="space-y-3 text-[var(--text)]">
          {perf.isLoading && !perf.data ? (
            <Loading />
          ) : !pg ? (
            <Empty title="还没有这个实例的数据" hint="实例启动后十几秒就有采样了" />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <StatTile size="sm" label="CPU" value={cores(pNow?.cpu)} sub={perf.data?.cores ? `整机 ${perf.data.cores} 核` : undefined} />
                <StatTile size="sm" label="内存" value={bytes(pNow?.mem)} sub={pg.memLimit ? `上限 ${bytes(pg.memLimit)}` : undefined} />
                <StatTile size="sm" label="网络" value={rate(pNow?.rx)} sub={`↑ ${rate(pNow?.tx)}`} />
              </div>
              {pg.containers.length > 0 && (
                <div className="truncate text-xs text-muted">
                  {pg.containers.map((c) => `${ROLE_LABEL[c.role] ?? c.role}${c.running ? "" : "（未运行）"}`).join(" · ")} · 进程 {pg.pids ?? "—"}
                </div>
              )}
              {!pg.running && <div className="text-xs text-muted">实例未运行，下面显示的是最后一次采样。</div>}
              <div className="flex gap-2">
                <div className="flex-1">
                  <Segmented value={perfMetric} options={PERF_METRICS} onChange={setPerfMetric} />
                </div>
                <div className="flex-1">
                  <Segmented value={perfRange} options={RANGES} onChange={setPerfRange} />
                </div>
              </div>
              <PerfChart title={PERF_METRICS.find((m) => m.value === perfMetric)?.label ?? "性能"} list={pHistory} height={130} {...pSeries} />
              <div className="text-[11px] text-muted">每 {perf.data?.interval ?? 10} 秒采样一次，保留最近 24 小时；CPU 按核计，内存不含页缓存。</div>
            </>
          )}
        </div>
      </Sheet>

      <Sheet open={!!editing} onClose={() => setEditing(null)} title="实例设置">
        {editing && (
          <div className="space-y-4 text-[var(--text)]">
            <InstanceFields draft={editing} onChange={setEditing} caps={caps.data} agents={agents.data} editing />
            <Button variant="primary" className="w-full" loading={busy} onClick={() => saveSettings()}>
              保存{running ? "（选项有变化时会重启）" : ""}
            </Button>
          </div>
        )}
      </Sheet>

      <Sheet open={!!gsf} onClose={() => setGsf(null)} title="Google 设备登记">
        <div className="space-y-3 text-[var(--text)] text-sm">
          <p>这台安卓没有经过 Google 认证。第一次登录 Play 商店前，用你的 Google 账号把下面的设备 ID 登记一次，等几分钟再登录。</p>
          <div className="font-mono text-base select-all bg-surface-2 rounded-lg px-3 py-2 break-all">{gsf}</div>
          <a className="text-accent underline" href="https://www.google.com/android/uncertified/" target="_blank" rel="noreferrer">
            打开 Google 登记页面
          </a>
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

      <Sheet open={paste} onClose={() => setPaste(false)} title="粘贴文字">
        <div className="space-y-4 text-[var(--text)]">
          <textarea
            className={cx(inputClass, "min-h-32")}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={android ? "内容会直接输入到当前输入框" : "内容会放进剪贴板并按 Ctrl+V"}
          />
          <Button
            variant="primary"
            className="w-full"
            onClick={() =>
              act(async () => {
                await api.post(`/api/desktops/${id}/clipboard`, { text: pasteText });
                const r = rfb.current;
                if (r && !android) {
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
