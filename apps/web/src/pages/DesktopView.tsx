import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronLeft, ClipboardPaste, Eraser, Hand, Keyboard, Loader2, Maximize, MoreVertical, Pause, Play, Power, RotateCcw, Settings2, Smartphone, Stethoscope, Trash2, Undo2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { InstanceFields, type InstanceDraft } from "../components/InstanceFields";
import { PerfChart, compactBytes, compactCores, compactRate, type PerfSeriesDef } from "../components/PerfChart";
import { Button, confirmDialog, Empty, Field, Loading, MenuDivider, MenuItem, Popover, Segmented, Sheet, StatTile, cx, inputClass, toast } from "../components/ui";
import { ApiError, api, errorMessage } from "../lib/api";
import { KIND_INFO, OP_LABEL, OP_NAME, leaseText } from "../lib/instances";
import { RANGES, ROLE_LABEL, bytes, cores, rate, type InstancePerf, type PerfPoint, type PerfRange } from "../lib/perf";
import type { Agent, Desktop, HostCaps, InstanceHealth } from "../lib/types";
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
  const [healthOpen, setHealthOpen] = useState(false);
  const resuming = useRef(false);

  const desktop = useQuery({
    queryKey: ["desktops", id],
    queryFn: () => api.get<Desktop>(`/api/desktops/${id}`),
    // Changes arrive over SSE; this is the safety net, faster while something is starting or being repaired.
    refetchInterval: (q) => (q.state.data?.op ? 2_000 : 60_000),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
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
  // What the hub found wrong (container states, restart counts, the control service, telling log lines), fetched when asked for.
  const health = useQuery({
    queryKey: ["desktop-health", id],
    queryFn: () => api.get<InstanceHealth>(`/api/desktops/${id}/health`),
    enabled: healthOpen && !!id,
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.op ? 3_000 : false),
  });
  const d = desktop.data;
  const gone = desktop.error instanceof ApiError && desktop.error.status === 404;
  const mine = d?.leaseInfo.holder === "human";
  const running = d?.state === "running";
  const android = d?.kind === "android";
  const op = d?.op ?? null;
  // While it is being restarted or repaired the screen is on its way out; don't chase it.
  const live = running && !op;

  const { rfb, state: connState, connect } = useVnc(id, live, screen);

  // Opening a paused instance thaws it: the screen should be live while someone looks at it.
  useEffect(() => {
    if (d?.state !== "paused" || resuming.current) return;
    resuming.current = true;
    void api
      .post(`/api/desktops/${id}/resume`)
      .then(() => qc.invalidateQueries({ queryKey: ["desktops"] }))
      .catch((err) => toast(errorMessage(err), "danger"))
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
  /** Runs a request with the busy state and a toast; resolves whether it worked. */
  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      await refresh();
      return true;
    } catch (err) {
      toast(errorMessage(err), "danger");
      return false;
    } finally {
      setBusy(false);
    }
  };
  /**
   * Start / stop / restart / pause / repair run on the hub in the background: the request answers at once and the
   * progress (and a failure's reason) shows on the instance, so a slow Android boot can't hit a proxy's timeout.
   */
  const background = (action: "start" | "stop" | "restart" | "pause" | "repair", started: string) =>
    act(() => api.post(`/api/desktops/${id}/${action}${action === "repair" ? "" : "?wait=0"}`), started);
  const repair = async () => {
    if (d?.leaseInfo.holder === "agent" && !(await confirmDialog({ title: "修复这个实例？", body: "agent 正在使用它，修复会先停止再启动，打断它的操作。", ok: "修复", danger: true }))) return;
    setHealthOpen(false);
    await background("repair", "开始修复，数据会保留");
  };
  const reset = async () => {
    if (!(await confirmDialog({ title: `清空重建「${d?.name ?? ""}」？`, body: "里面的 App、数据和登录状态都会删掉，无法恢复。", ok: "清空重建", danger: true }))) return;
    setHealthOpen(false);
    await act(() => api.post(`/api/desktops/${id}/reset`, { confirmDataLoss: true }), "开始清空重建");
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
    api.post(`/api/desktops/${id}/clipboard`, { text }).catch((err) => toast(errorMessage(err), "danger"));
  };
  const androidKey = (keys: string) => {
    api.post(`/api/desktops/${id}/action`, { type: "key", keys }).catch((err) => toast(errorMessage(err), "danger"));
  };
  const openSettings = () => {
    if (!d) return;
    setEditing({ name: d.name, kind: d.kind, options: d.options, agentIds: d.agentIds });
  };
  const saveSettings = async (confirmDataLoss = false) => {
    if (!editing || !d) return;
    try {
      setBusy(true);
      const r = await api.patch<{ restarted: boolean; wiped: boolean }>(`/api/desktops/${id}?wait=0`, {
        name: editing.name.trim() || d.name,
        options: editing.options,
        agentIds: editing.agentIds,
        confirmDataLoss,
      });
      toast(r.restarted ? "已保存，正在重启实例" : "已保存");
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["desktops"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "confirm" && (await confirmDialog({ title: "继续保存？", body: e.message, ok: "继续", danger: true }))) return saveSettings(true);
      toast(errorMessage(err), "danger");
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
              {connState === "connecting" && live && " · 连接中…"}
              {connState === "disconnected" && live && " · 已断开"}
            </div>
          </div>
          {live && !mine && (
            <Button size="sm" variant="primary" loading={busy} onClick={() => act(() => api.post(`/api/desktops/${id}/takeover`), "已接管，agent 暂停操作")}>
              <Hand className="size-4" /> 接管
            </Button>
          )}
          {mine && (
            <Button size="sm" variant="primary" onClick={() => setHandback(true)}>
              <Undo2 className="size-4" /> 交还
            </Button>
          )}
          <Popover
            label="更多"
            side="bottom"
            align="right"
            className="w-64 p-1.5 text-[var(--text)]"
            triggerClassName="size-10 grid place-items-center rounded-md hover:bg-white/10 aria-expanded:bg-white/10"
            trigger={<MoreVertical className="size-5" />}
          >
            {(close) => {
              const run = (fn: () => unknown) => () => {
                close();
                void fn();
              };
              return (
                <>
                  <MenuItem icon={<Maximize />} label={fit ? "原始大小（拖动查看）" : "适应屏幕"} onClick={run(() => setFit(!fit))} />
                  <MenuItem icon={<Settings2 />} label="实例设置" onClick={run(openSettings)} />
                  <MenuItem icon={<Activity />} label="性能" onClick={run(() => setPerfOpen(true))} />
                  <MenuItem icon={<Stethoscope />} label="诊断与修复" onClick={run(() => setHealthOpen(true))} />
                  {android && d?.options.googlePlay && running && (
                    <MenuItem
                      icon={<Smartphone />}
                      label="Google 设备登记"
                      onClick={run(() =>
                        act(async () => {
                          const r = await api.get<{ id: string | null; error?: string }>(`/api/desktops/${id}/android/gsf-id`);
                          if (!r.id) throw new Error(r.error ?? "还没有生成设备 ID，打开一次 Play 商店后再试");
                          setGsf(r.id);
                        }),
                      )}
                    />
                  )}
                  {(running || d?.state === "paused") && <MenuDivider />}
                  {!op && running && d?.leaseInfo.holder === "none" && <MenuItem icon={<Pause />} label="暂停（保留内存）" onClick={run(() => background("pause", "开始暂停"))} />}
                  {!op && (running || d?.state === "paused") && (
                    <MenuItem
                      icon={<RotateCcw />}
                      label="重启"
                      onClick={run(async () => {
                        if (d?.leaseInfo.holder === "agent" && !(await confirmDialog({ title: "重启这个实例？", body: "agent 正在使用它，重启会打断它的操作。", ok: "重启", danger: true }))) return;
                        return background("restart", "开始重启");
                      })}
                    />
                  )}
                  {!op && (running || d?.state === "paused") && d?.leaseInfo.holder === "none" && <MenuItem icon={<Power />} label="停止" onClick={run(() => background("stop", "开始停止"))} />}
                  <MenuDivider />
                  {!op && (
                    <MenuItem
                      icon={<Trash2 />}
                      label="删除实例"
                      danger
                      onClick={run(async () => {
                        if (!(await confirmDialog({ title: `删除「${d?.name ?? ""}」？`, body: `里面的${android ? "App 和数据" : "浏览器登录状态和文件"}会一并删除，分给它的 agent 也会解除绑定。`, ok: "删除", danger: true }))) return;
                        return act(() => api.del(`/api/desktops/${id}`), "已删除").then((ok) => ok && nav("/instances", { replace: true }));
                      })}
                    />
                  )}
                  <MenuDivider />
                  <div className="px-2.5 py-1.5 text-xs text-muted leading-5">
                    {android
                      ? "接管后：点击＝点按，拖动＝滑动，右键＝返回；输入中文用「键盘」或「粘贴文字」。"
                      : "横屏查看更清楚。接管后：单指点击＝左键，双指点击＝右键，双指拖动＝滚动。"}
                  </div>
                </>
              );
            }}
          </Popover>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {live ? (
          <div ref={screen} className="absolute inset-0" />
        ) : (
          <div className="absolute inset-0 grid place-items-center px-6">
            <div className="text-center space-y-3 max-w-sm">
              {gone ? (
                <>
                  <div className="opacity-80 text-sm">这个实例不存在，可能已经被删除</div>
                  <Button onClick={() => nav("/instances", { replace: true })}>回到实例列表</Button>
                </>
              ) : desktop.isError && !d ? (
                <>
                  <div className="opacity-80 text-sm">{errorMessage(desktop.error)}</div>
                  <Button onClick={() => void desktop.refetch()}>重试</Button>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-center gap-2 opacity-80 text-sm">
                    {(desktop.isLoading || op || d?.state === "paused" || d?.state === "starting") && <Loader2 className="size-4 animate-spin" />}
                    {desktop.isLoading
                      ? "加载中…"
                      : op
                        ? `${OP_LABEL[op]}…${android && op !== "stopping" && op !== "pausing" ? "（安卓需要一两分钟）" : ""}`
                        : d?.state === "paused"
                          ? "正在恢复…"
                          : d?.state === "starting"
                            ? "正在启动…"
                            : "实例未运行"}
                  </div>
                  {d?.error && !op && (
                    <div className="text-xs text-left rounded-lg bg-[color-mix(in_oklab,var(--danger)_25%,transparent)] px-3 py-2 whitespace-pre-wrap break-words">
                      {OP_NAME[d.error.op]}没有成功：{d.error.message}
                    </div>
                  )}
                  {d && !op && d.state !== "paused" && (
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button variant="primary" loading={busy} onClick={() => void background("start", "开始启动")}>
                        <Play className="size-4" /> {d.error ? "重试启动" : "启动"}
                      </Button>
                      {d.error && (
                        <Button loading={busy} onClick={() => void repair()}>
                          <Wrench className="size-4" /> 修复
                        </Button>
                      )}
                      <Button onClick={() => setHealthOpen(true)}>
                        <Stethoscope className="size-4" /> 诊断
                      </Button>
                    </div>
                  )}
                  {d && !op && d.error && android && (
                    <button type="button" className="text-xs underline opacity-70 hover:opacity-100" onClick={() => void reset()}>
                      还是不行？清空重建（会丢掉 App 和数据）
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {live && connState === "disconnected" && (
          <div className="absolute inset-x-0 bottom-6 flex justify-center">
            <Button variant="secondary" onClick={() => void connect()}>
              重新连接
            </Button>
          </div>
        )}
        {live && !mine && d?.leaseInfo.holder === "agent" && (
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

      <Sheet open={healthOpen} onClose={() => setHealthOpen(false)} title={`诊断 · ${d?.name ?? "实例"}`}>
        <div className="space-y-3 text-[var(--text)]">
          {health.isLoading ? (
            <Loading />
          ) : health.isError ? (
            <div className="text-sm text-danger">{errorMessage(health.error)}</div>
          ) : health.data ? (
            <>
              <div className="text-sm font-medium">
                {health.data.op
                  ? `${OP_LABEL[health.data.op]}…`
                  : health.data.ok
                    ? health.data.state === "running"
                      ? "运行正常"
                      : health.data.state === "paused"
                        ? "已暂停（用到时自动恢复）"
                        : "已停止（用到时自动启动）"
                    : (health.data.problem ?? "有问题")}
              </div>
              {d?.error && !health.data.op && (
                <div className="text-xs rounded-lg bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] text-danger px-3 py-2 whitespace-pre-wrap break-words">
                  上次{OP_NAME[d.error.op]}没有成功：{d.error.message}
                </div>
              )}
              <pre className="text-[11.5px] leading-relaxed bg-surface-2 rounded-lg px-3 py-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{health.data.detail || "没有更多信息"}</pre>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="primary" disabled={!!op || !!health.data.op} onClick={() => void repair()}>
                  <Wrench className="size-4" /> 修复
                </Button>
                <Button loading={health.isFetching} onClick={() => void health.refetch()}>
                  重新检查
                </Button>
              </div>
              <div className="text-xs text-muted">修复会先正常停止实例、清理上次强制停止留下的锁文件再启动；还不行就重建容器。浏览器登录状态、文件和安卓数据都会保留。</div>
              {android && (
                <Button variant="danger" className="w-full" disabled={!!op || !!health.data.op} onClick={() => void reset()}>
                  <Eraser className="size-4" /> 清空重建（丢掉 App 和数据）
                </Button>
              )}
            </>
          ) : null}
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
              act(() => api.post(`/api/desktops/${id}/handback`, { note }), "已交还").then((ok) => {
                if (!ok) return;
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
