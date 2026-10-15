import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, List, Monitor, MoreHorizontal, Pause, PictureInPicture2, Play, Plus, Power, RotateCcw, Search, Trash2, Wrench } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { InstanceFields, type InstanceDraft } from "../components/InstanceFields";
import { InstanceThumb } from "../components/InstanceThumb";
import { Button, Card, Empty, Header, HeaderButton, Loading, MenuDivider, MenuItem, Popover, Segmented, Select, Sheet, StatusDot, Tabs, confirmDialog, cx, toast } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { setAppearance, useAppearance } from "../lib/appearance";
import { timeAgo } from "../lib/format";
import { openInstanceWindow } from "../lib/instanceWindow";
import { GROUP_LABEL, KINDS, KIND_INFO, SORT_OPTIONS, groupOf, leaseText, matchesQuery, sortInstances, type InstanceGroup } from "../lib/instances";
import { bytes, cores, type PerfData } from "../lib/perf";
import type { Agent, Desktop, DesktopKind, HostCaps } from "../lib/types";

const EMPTY: InstanceDraft = { name: "", kind: "browser", options: {}, agentIds: [] };
const GROUPS: InstanceGroup[] = ["running", "paused", "stopped", "error"];

export default function Desktops() {
  const nav = useNavigate();
  const { instanceView: view, instanceSort: sort } = useAppearance();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const list = useQuery({
    queryKey: ["desktops"],
    queryFn: () => api.get<Desktop[]>("/api/desktops"),
    // Changes arrive over SSE; this is the safety net, and a faster check while something is starting or being repaired.
    refetchInterval: (q) => (q.state.data?.some((d) => d.op) ? 2_000 : 60_000),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const perf = useQuery({ queryKey: ["perf", "now"], queryFn: () => api.get<PerfData>("/api/perf?history=0"), refetchInterval: 10_000 });
  const caps = useQuery({ queryKey: ["hostcaps"], queryFn: () => api.get<HostCaps>("/api/desktops/capabilities"), refetchInterval: (q) => (q.state.data?.checkedAt ? false : 3000) });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<InstanceDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);

  // The tab and the kind filter live in the URL, like the other list pages' filters.
  const statusParam = params.get("status");
  const status: "all" | InstanceGroup = GROUPS.find((g) => g === statusParam) ?? "all";
  const typeParam = params.get("type");
  const kind: "all" | DesktopKind = KINDS.find((k) => k === typeParam) ?? "all";
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const open = () => {
    const firstOk = caps.data ? KINDS.find((k) => caps.data!.kinds[k].ok) : undefined;
    setDraft({ ...EMPTY, kind: firstOk ?? "browser" });
    setCreating(true);
  };

  const create = async () => {
    setBusy(true);
    try {
      const d = await api.post<Desktop>("/api/desktops", { name: draft.name.trim() || KIND_INFO[draft.kind].label, kind: draft.kind, options: draft.options, agentIds: draft.agentIds });
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ["desktops"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      nav(`/instances/${d.id}`);
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  const all = list.data ?? [];
  const instance = (id: string) => perf.data?.groups.find((g) => g.type === "instance" && g.id === id);
  // The sampled usage only counts while the instance itself says it is running (a sample can lag a stop by a few seconds).
  const memory = (id: string) => {
    const g = instance(id);
    return g?.running && all.find((d) => d.id === id)?.state === "running" ? (g.now?.mem ?? 0) : 0;
  };
  // Counts follow the search and the kind filter; the tab then narrows the list itself.
  const matching = all.filter((d) => (kind === "all" || d.kind === kind) && matchesQuery(d, query, agents.data));
  const count = (g: InstanceGroup) => matching.filter((d) => groupOf(d) === g).length;
  const shown = sortInstances(
    matching.filter((d) => status === "all" || groupOf(d) === status),
    sort,
    memory,
  );
  const filtered = !!query.trim() || kind !== "all" || status !== "all";
  const tabs = [
    { value: "all" as const, label: "全部", count: matching.length },
    ...GROUPS.filter((g) => g !== "error" || count("error") > 0 || status === "error").map((g) => ({ value: g, label: GROUP_LABEL[g], count: count(g) })),
  ];

  // Nobody holds, watches or is changing these: what a bulk "free some memory" may touch.
  const idle = all.filter((d) => d.leaseInfo.holder === "none" && d.viewers === 0 && !d.op);
  const running = idle.filter((d) => d.state === "running");
  const stoppable = idle.filter((d) => d.state === "running" || d.state === "paused");
  const release = async (action: "stop" | "pause", targets: Desktop[]) => {
    const names = targets.slice(0, 6).map((d) => `「${d.name}」`).join("、") + (targets.length > 6 ? ` 等 ${targets.length} 个` : "");
    const verb = action === "stop" ? "停止" : "暂停";
    const body =
      action === "stop"
        ? `${names}。没保存的页面和程序状态会丢，登录状态、文件和安卓数据会保留；agent 用到时会自动启动。正在被 agent 或你使用的不受影响。`
        : `${names}。暂停后画面冻结、内存仍占着，用到时几秒内恢复。正在被 agent 或你使用的不受影响。`;
    if (!(await confirmDialog({ title: `${verb} ${targets.length} 个空闲实例？`, body, ok: verb }))) return;
    try {
      const r = await api.post<{ ids: string[] }>("/api/desktops/bulk", { action });
      toast(r.ids.length ? `开始${verb} ${r.ids.length} 个实例` : "没有可处理的空闲实例");
      void qc.invalidateQueries({ queryKey: ["desktops"] });
    } catch (err) {
      toast(errorMessage(err), "danger");
    }
  };

  // Only when the hub can see the machine (or its cgroup); from inside a bare container the figure isn't the host's.
  const hostInfo = perf.data?.host.info;
  const hostOk = hostInfo?.scope === "host" || hostInfo?.scope === "cgroup";
  const hostNow = hostOk ? (perf.data?.host.now?.mem ?? null) : null;
  const hostTotal = hostOk ? (hostInfo?.memTotal ?? null) : null;
  const usedByInstances = all.reduce((sum, d) => sum + memory(d.id), 0);

  return (
    <div>
      <Header
        title="实例"
        sub="浏览器、Linux 桌面和安卓实例，随时查看和接管"
        right={
          <div className="flex items-center gap-2">
            <div className="w-16">
              <Segmented
                value={view}
                onChange={(v) => setAppearance({ instanceView: v })}
                options={[
                  { value: "card", label: <LayoutGrid className="size-3.5" />, title: "卡片" },
                  { value: "list", label: <List className="size-3.5" />, title: "列表" },
                ]}
              />
            </div>
            {all.length > 0 && (
              <Popover
                label="批量操作"
                side="bottom"
                align="right"
                className="w-64 p-1.5 text-[var(--text)]"
                triggerClassName="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 aria-expanded:bg-surface-2 [&_svg]:size-4"
                trigger={<MoreHorizontal />}
              >
                {(close) => (
                  <>
                    <div className="px-2.5 py-1.5 text-xs text-muted">空闲实例：没人在用、没人在看、也没有操作在进行</div>
                    {stoppable.length > 0 && (
                      <MenuItem
                        icon={<Power />}
                        label="停止所有空闲实例"
                        hint={`${stoppable.length} 个`}
                        onClick={() => {
                          close();
                          void release("stop", stoppable);
                        }}
                      />
                    )}
                    {running.length > 0 && (
                      <MenuItem
                        icon={<Pause />}
                        label="暂停所有空闲实例"
                        hint={`${running.length} 个`}
                        onClick={() => {
                          close();
                          void release("pause", running);
                        }}
                      />
                    )}
                    {stoppable.length === 0 && <div className="px-2.5 py-1.5 text-[13px] text-muted">现在没有可以处理的空闲实例</div>}
                  </>
                )}
              </Popover>
            )}
            <HeaderButton icon={<Plus />} label="新建实例" onClick={open} />
          </div>
        }
      />
      <div className="px-4 pb-8 space-y-3">
        {list.isLoading ? (
          <Loading />
        ) : !all.length ? (
          <Card>
            <Empty
              icon={<Monitor className="size-6" strokeWidth={1.8} />}
              title="还没有实例"
              hint="新建一个浏览器、Linux 桌面或安卓实例并分给 agent；agent 需要时也可以自己新建"
              action={
                <Button variant="primary" onClick={open}>
                  新建实例
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <label className="flex-1 min-w-44 flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface text-[13px] focus-within:border-[var(--color-accent)]">
                <Search className="size-3.5 text-muted shrink-0" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名字、类型或 agent" className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-muted" />
              </label>
              <Select
                label="类型"
                className="w-32 shrink-0"
                value={kind}
                options={[{ value: "all" as const, label: "全部类型" }, ...KINDS.map((k) => ({ value: k, label: KIND_INFO[k].label }))]}
                onChange={(v) => setFilter("type", v)}
              />
              <Select label="排序" className="w-32 shrink-0" value={sort} options={SORT_OPTIONS} onChange={(v) => setAppearance({ instanceSort: v })} />
            </div>
            <Tabs value={status} options={tabs} onChange={(v) => setFilter("status", v)} />
            {!shown.length ? (
              <Empty title={filtered ? "没有符合条件的实例" : "还没有实例"} hint={filtered ? "换个关键词或筛选条件试试" : undefined} />
            ) : (
              <div className={view === "card" ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3" : "bg-surface rounded-xl border border-line divide-y divide-line"}>
                {shown.map((d) => {
                  const l = leaseText(d, agents.data);
                  const Icon = KIND_INFO[d.kind].icon;
                  const users = agents.data?.filter((a) => d.agentIds.includes(a.id)) ?? [];
                  const p = instance(d.id);
                  const info = (
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{d.name}</div>
                      <div className="flex items-center gap-1 text-xs text-muted min-w-0 mt-0.5">
                        <StatusDot tone={l.tone} className="shrink-0 max-w-[65%]">
                          {l.text}
                        </StatusDot>
                        <span className="truncate">
                          · {KIND_INFO[d.kind].label} · {users.length ? users.map((a) => a.emoji).join("") : "没有分给 agent"} · {timeAgo(d.last_used_at)}
                        </span>
                      </div>
                      {p?.running && d.state === "running" && p.now && (
                        <div className="text-xs text-muted tabular-nums truncate mt-0.5">
                          CPU {cores(p.now.cpu)} · 内存 {p.memLimit ? `${bytes(p.now.mem).replace(" GB", "")}/${bytes(p.memLimit)}` : bytes(p.now.mem)}
                        </div>
                      )}
                    </div>
                  );
                  if (view === "list") {
                    return (
                      <div key={d.id} onClick={() => nav(`/instances/${d.id}`)} className="flex items-center gap-3 px-3 py-2 cursor-pointer first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2 active:bg-surface-2">
                        <InstanceThumb d={d} width={160} className="w-20 sm:w-24 aspect-[16/10] rounded-md shrink-0" />
                        <Icon className="size-4 text-muted shrink-0 hidden sm:block" aria-label={KIND_INFO[d.kind].label} />
                        {info}
                        <InstanceMenu d={d} />
                      </div>
                    );
                  }
                  return (
                    <Card key={d.id} onClick={() => nav(`/instances/${d.id}`)}>
                      <InstanceThumb d={d} width={640} className="aspect-[16/10] border-b border-line rounded-t-[11px]" />
                      <div className="px-3.5 py-3 flex items-start gap-2.5">
                        <Icon className="size-4 text-muted shrink-0 mt-0.5" aria-label={KIND_INFO[d.kind].label} />
                        {info}
                        <InstanceMenu d={d} className="-my-1 -mr-1.5" />
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
            <div className="px-1 text-xs text-muted tabular-nums">
              {filtered ? `${shown.length} / ${all.length} 个` : `共 ${all.length} 个`}
              {usedByInstances > 0 && ` · 运行中的占用内存 ${bytes(usedByInstances)}`}
              {hostNow != null && hostTotal != null && ` · 整机 ${bytes(hostNow)} / ${bytes(hostTotal)}`}
            </div>
          </>
        )}
      </div>
      <Sheet open={creating} onClose={() => setCreating(false)} title="新建实例">
        <div className="space-y-4">
          <InstanceFields draft={draft} onChange={setDraft} caps={caps.data} agents={agents.data} />
          <Button variant="primary" className="w-full" loading={busy} disabled={!!caps.data && !caps.data.kinds[draft.kind].ok} onClick={create}>
            创建
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

/**
 * The ⋯ menu on an instance's card or row: what you would do from its page, without opening it.
 * Start / pause / stop / restart / repair run on the hub in the background (progress shows on the instance).
 */
function InstanceMenu({ d, className }: { d: Desktop; className?: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["desktops"] });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      void refresh();
    } catch (err) {
      toast(errorMessage(err), "danger");
    }
  };
  const post = (action: "start" | "stop" | "restart" | "pause" | "repair" | "resume", ok: string) =>
    run(() => api.post(`/api/desktops/${d.id}/${action}${action === "repair" || action === "resume" ? "" : "?wait=0"}`), ok);

  const idle = d.leaseInfo.holder === "none";
  const live = d.state === "running" || d.state === "paused";
  const busy = !!d.op;

  return (
    // Inside a clickable card: keep a click on the menu from also opening the instance.
    <div onClick={(e) => e.stopPropagation()} className={cx("shrink-0", className)}>
      <Popover
        label={`${d.name}的操作`}
        side="bottom"
        align="right"
        className="w-52 p-1.5 text-[var(--text)]"
        triggerClassName="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 aria-expanded:bg-surface-2 [&_svg]:size-4"
        trigger={<MoreHorizontal />}
      >
        {(close) => {
          const act = (fn: () => unknown) => () => {
            close();
            void fn();
          };
          return (
            <>
              {d.state === "running" && <MenuItem icon={<PictureInPicture2 />} label="小窗查看" onClick={act(() => openInstanceWindow(d.id))} />}
              {!busy && !live && <MenuItem icon={<Play />} label={d.error ? "重试启动" : "启动"} onClick={act(() => post("start", "开始启动"))} />}
              {!busy && d.state === "paused" && <MenuItem icon={<Play />} label="恢复" onClick={act(() => post("resume", "已恢复"))} />}
              {!busy && d.error && <MenuItem icon={<Wrench />} label="修复" hint="数据保留" onClick={act(() => post("repair", "开始修复，数据会保留"))} />}
              {!busy && d.state === "running" && idle && <MenuItem icon={<Pause />} label="暂停" hint="保留内存" onClick={act(() => post("pause", "开始暂停"))} />}
              {!busy && live && (
                <MenuItem
                  icon={<RotateCcw />}
                  label="重启"
                  onClick={act(async () => {
                    if (!idle && !(await confirmDialog({ title: "重启这个实例？", body: "有人正在使用它，重启会打断操作。", ok: "重启", danger: true }))) return;
                    return post("restart", "开始重启");
                  })}
                />
              )}
              {!busy && live && idle && <MenuItem icon={<Power />} label="停止" hint="释放内存" onClick={act(() => post("stop", "开始停止"))} />}
              {!busy && (
                <>
                  <MenuDivider />
                  <MenuItem
                    icon={<Trash2 />}
                    label="删除实例"
                    danger
                    onClick={act(async () => {
                      const body = `里面的${d.kind === "android" ? "App 和数据" : "浏览器登录状态和文件"}会一并删除，分给它的 agent 也会解除绑定。`;
                      if (!(await confirmDialog({ title: `删除「${d.name}」？`, body, ok: "删除", danger: true }))) return;
                      return run(() => api.del(`/api/desktops/${d.id}`), "已删除");
                    })}
                  />
                </>
              )}
              {busy && <div className="px-2.5 py-1.5 text-[13px] text-muted">操作进行中，稍等</div>}
            </>
          );
        }}
      </Popover>
    </div>
  );
}
