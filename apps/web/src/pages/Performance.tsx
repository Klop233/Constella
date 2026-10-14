import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, RefreshCw, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { PerfChart, compactBytes, compactRate } from "../components/PerfChart";
import { Badge, Card, Header, Loading, Section, Segmented, StatTile, cx } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { KIND_INFO } from "../lib/instances";
import { RANGES, ROLE_LABEL, bytes, cores, duration, percent, rate, type HostInfo, type PerfContainer, type PerfData, type PerfGroup, type PerfPoint, type PerfRange } from "../lib/perf";
import type { DesktopKind } from "../lib/types";

const SCOPE_LABEL: Record<HostInfo["scope"], string> = { host: "整机", cgroup: "cgroup 切片", container: "容器" };
const SCOPE_NOTE: Record<HostInfo["scope"], string> = {
  host: "",
  cgroup: "hub 读到的是它所在 cgroup（LXC 容器或类似的资源切片）的用量，不是整台物理机。",
  container: "没有挂载宿主的 /proc 和 /sys/fs/cgroup，这里只有 hub 容器自己的数字；内存可能仍是整台机器的。",
};

function Item({ label, value, mono, title }: { label: string; value: ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className={cx("min-w-0 truncate", mono ? "font-mono text-[12.5px]" : "text-[13px]")} title={title}>
        {value}
      </dd>
    </div>
  );
}

/** Containers and groups are counted in cores (1 核 = one core fully busy); the host as a share of all of them. */
function cpuText(now: PerfPoint | null | undefined, hostCores: number | null): string {
  if (now?.cpu == null) return "—";
  return hostCores ? `${cores(now.cpu)} · ${percent(now.cpu / hostCores, 1)}` : cores(now.cpu);
}

function Dot({ on }: { on: boolean }) {
  return <span className={cx("size-2 shrink-0 rounded-full", on ? "bg-accent" : "border border-[var(--muted)] opacity-60")} />;
}

function ContainerLine({ c, hostCores }: { c: PerfContainer; hostCores: number | null }) {
  const role = ROLE_LABEL[c.role] ?? (c.role || "容器");
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 min-w-0 text-[11.5px]">
        <Dot on={c.running} />
        <span className="font-mono text-[11.5px] truncate">{c.name}</span>
        <span className="shrink-0 text-muted">{role}</span>
        <span className="flex-1" />
        <span className="shrink-0 tabular-nums text-muted">{c.running ? cpuText(c.now, hostCores) : "未运行"}</span>
      </div>
      {c.running && (
        <div className="truncate pl-4 text-[11px] tabular-nums text-muted">
          内存 {bytes(c.now?.mem)}
          {c.memLimit ? ` / ${bytes(c.memLimit)}` : ""} · 网络 ↓ {rate(c.now?.rx)} ↑ {rate(c.now?.tx)} · 进程 {c.pids ?? "—"}
        </div>
      )}
    </div>
  );
}

function GroupRow({ g, hostCores }: { g: PerfGroup; hostCores: number | null }) {
  const [open, setOpen] = useState(false);
  const kind = g.type === "instance" ? KIND_INFO[g.kind as DesktopKind] : null;
  const Icon = kind?.icon ?? (g.type === "agent" ? Bot : Server);
  const sub = [g.running ? "运行中" : "已停止", kind?.label ?? (g.type === "agent" ? "agent" : "服务"), g.containers.length ? `${g.containers.length} 个容器` : null, g.pids != null ? `进程 ${g.pids}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2 active:bg-surface-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-[15px]">{g.emoji ?? <Icon className="size-4 text-muted" strokeWidth={1.8} />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <Dot on={g.running} />
            <span className="truncate">{g.name}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted">{sub}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[13px] tabular-nums">{cpuText(g.now, hostCores)}</span>
          <span className="mt-0.5 block text-[11px] tabular-nums text-muted">{bytes(g.now?.mem)}</span>
        </span>
        <ChevronDown className={cx("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="space-y-2 px-3.5 pt-0.5 pb-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            <Item label="内存上限" value={g.memLimit ? bytes(g.memLimit) : "不限"} />
            <Item label="进程" value={g.pids ?? "—"} />
            <Item label="网络下行" value={rate(g.now?.rx)} />
            <Item label="网络上行" value={rate(g.now?.tx)} />
          </dl>
          {g.containers.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-2">
              {g.containers.map((c) => (
                <ContainerLine key={c.name} c={c} hostCores={hostCores} />
              ))}
            </div>
          )}
          {g.type === "instance" && (
            <Link to={`/instances/${g.id}`} className="inline-block text-xs text-muted hover:text-[var(--text)]">
              打开实例 ›
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export default function Performance() {
  const [range, setRange] = useState<PerfRange>("1h");
  const q = useQuery({ queryKey: ["perf", range], queryFn: () => api.get<PerfData>(`/api/perf?range=${range}`), refetchInterval: 10_000 });
  const d = q.data;
  const info = d?.host.info ?? null;
  const now = d?.host.now ?? null;
  const history = d?.host.history ?? [];
  const groups = d?.groups ?? [];
  const hostCores = info?.cores ?? null;
  const value = (v: ReactNode) => <span className="text-[11px] tabular-nums text-muted">{v}</span>;
  const netLegend = (
    <span className="flex shrink-0 items-center gap-2.5 text-[11px] tabular-nums text-muted">
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-full" style={{ background: "var(--series-1)" }} />
        下行 {rate(now?.rx)}
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-full" style={{ background: "var(--series-2)" }} />
        上行 {rate(now?.tx)}
      </span>
    </span>
  );

  return (
    <div>
      <Header
        title="性能"
        sub={d ? `每 ${d.interval} 秒采样 · ${timeAgo(new Date(q.dataUpdatedAt).toISOString())}更新` : "读取中…"}
        right={
          <button aria-label="立即刷新" title="立即刷新" onClick={() => void q.refetch()} className="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2">
            <RefreshCw className={cx("size-4", q.isFetching && "animate-spin")} />
          </button>
        }
      />
      <div className="px-4 pb-8 space-y-5">
        <div className="flex items-center gap-2">
          <div className="w-52">
            <Segmented value={range} options={RANGES} onChange={setRange} />
          </div>
          <div className="flex-1" />
        </div>

        {!d ? (
          <Loading />
        ) : (
          <>
            <Section title="服务器">
              <Card className="p-3.5 space-y-2.5">
                {info ? (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-display text-[15px] font-semibold">{info.hostname}</span>
                      <Badge tone="muted" className="shrink-0">
                        {SCOPE_LABEL[info.scope]}
                      </Badge>
                    </div>
                    {!!(SCOPE_NOTE[info.scope] || !info.network) && (
                      <p className="text-xs leading-snug text-muted">
                        {SCOPE_NOTE[info.scope]}
                        {!info.network && `${SCOPE_NOTE[info.scope] ? " " : ""}读不到宿主网卡，网络数字为空。`}
                      </p>
                    )}
                    <dl className="grid grid-cols-1 gap-x-5 gap-y-1.5 border-t border-line pt-2.5 sm:grid-cols-2">
                      <Item label="系统" value={info.os || "—"} title={info.os} />
                      <Item label="内核" value={info.kernel || "—"} mono title={info.kernel} />
                      <Item label="CPU" value={info.cpuModel || "—"} title={info.cpuModel} />
                      <Item label="核心" value={`${info.cores} 核`} />
                      <Item label="内存" value={bytes(info.memTotal)} />
                      <Item label="交换" value={bytes(info.swapTotal)} />
                      <Item label="磁盘" value={info.disk ? `${info.disk.path} · ${bytes(info.disk.total)}` : "—"} title={info.disk?.path} />
                      <Item label="Docker" value={info.dockerVersion || "—"} mono />
                      <Item label="主机网络" value={info.network ? "可读" : "读不到"} />
                    </dl>
                  </>
                ) : (
                  <p className="text-sm text-muted">还没有采到数据，hub 刚启动的话等十几秒。</p>
                )}
              </Card>
            </Section>

            <Section title="实时占用">
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <StatTile label="CPU" value={percent(now?.cpu)} sub={info ? `共 ${info.cores} 核` : undefined} />
                <StatTile label="内存" value={bytes(now?.mem)} sub={`共 ${bytes(info?.memTotal)}`} />
                <StatTile label="网络下行" value={rate(now?.rx)} />
                <StatTile label="网络上行" value={rate(now?.tx)} />
                <StatTile size="sm" label="交换" value={bytes(now?.swap)} sub={info?.swapTotal ? `共 ${bytes(info.swapTotal)}` : undefined} />
                <StatTile size="sm" label="负载（1 分钟）" value={now ? now.load[0].toFixed(2) : "—"} sub={now ? `5 分钟 ${now.load[1].toFixed(2)} · 15 分钟 ${now.load[2].toFixed(2)}` : undefined} />
                <StatTile size="sm" label="运行时间" value={now ? duration(now.uptimeS) : "—"} />
                <StatTile size="sm" label="磁盘已用" value={bytes(now?.diskUsed)} sub={info?.disk ? `共 ${bytes(info.disk.total)}` : undefined} />
              </div>
            </Section>

            <Section title="历史" action={<span className="text-xs text-muted">内存中保留最近 24 小时</span>}>
              <Card className="p-3.5 space-y-4">
                <PerfChart
                  title="CPU"
                  list={history}
                  max={1}
                  format={percent}
                  tickFormat={percent}
                  series={[{ name: "使用率", value: (p) => p.cpu }]}
                  right={value(percent(now?.cpu))}
                />
                <PerfChart
                  title="内存"
                  list={history}
                  max={info?.memTotal ?? undefined}
                  format={bytes}
                  tickFormat={compactBytes}
                  series={[{ name: "已用", value: (p) => p.mem }]}
                  right={value(`${bytes(now?.mem)} / ${bytes(info?.memTotal)}`)}
                />
                <PerfChart
                  title="网络"
                  list={history}
                  format={rate}
                  tickFormat={compactRate}
                  right={netLegend}
                  series={[
                    { name: "下行", value: (p) => p.rx, color: "var(--series-1)" },
                    { name: "上行", value: (p) => p.tx, color: "var(--series-2)" },
                  ]}
                />
              </Card>
            </Section>

            <Section title="实例、agent 和服务" action={<span className="text-xs text-muted">{groups.length} 个</span>}>
              <Card className="divide-y divide-[var(--border)]">
                {groups.length === 0 ? (
                  <div className="px-3.5 py-3 text-sm text-muted">还没有实例或 agent。</div>
                ) : (
                  groups.map((g) => <GroupRow key={`${g.type}:${g.id}`} g={g} hostCores={hostCores} />)
                )}
              </Card>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
