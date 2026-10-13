import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { BarChart } from "../components/BarChart";
import { Card, Empty, Header, Loading, Segmented, StatTile, Tabs, cx, selectClass } from "../components/ui";
import { api } from "../lib/api";
import { STATUS_TEXT, statusTone, timeAgo, tokens } from "../lib/format";
import type { RunStatus } from "../lib/types";

interface Stats {
  totals: { requests: number; runs: number; input: number; cached: number; output: number; reasoning: number; hitRate: number | null };
  trend: { label: string; tokens: number; requests: number }[];
  models: { model: string; requests: number; runs: number; input: number; cached: number; output: number; successRate: number | null; tps: number | null; avgMs: number | null }[];
  agents: { agentId: string; name: string; emoji: string; requests: number; input: number; cached: number; output: number; spendUsd: number | null }[];
  log: { ts: string; agentId: string; model: string; input: number; cached: number; output: number; durationMs: number | null; tps: number | null; conversationId: string | null; status: RunStatus | null }[];
  spendUsd: number | null;
  filters: { models: string[]; agents: { id: string; name: string; emoji: string }[] };
}

const RANGES = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
] as const;

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const Dash = () => <span className="text-muted">—</span>;
const Unit = ({ children }: { children: string }) => <span className="text-xs text-muted ml-0.5">{children}</span>;

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={cx("py-2 px-2.5 text-xs font-medium text-muted whitespace-nowrap", right ? "text-right" : "text-left")}>{children}</th>;
}
function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cx("py-2.5 px-2.5 whitespace-nowrap tabular-nums", right && "text-right", className)}>{children}</td>;
}

export default function Usage() {
  const [range, setRange] = useState<"today" | "7d" | "30d">("today");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [metric, setMetric] = useState<"tokens" | "requests">("tokens");
  const [tab, setTab] = useState<"models" | "agents" | "log">("models");
  const qs = new URLSearchParams({ range, ...(agent && { agent }), ...(model && { model }) });
  const q = useQuery({ queryKey: ["usage-stats", range, agent, model], queryFn: () => api.get<Stats>(`/api/usage/stats?${qs}`), refetchInterval: 30_000 });
  const d = q.data;
  const agentName = (id: string) => d?.filters.agents.find((a) => a.id === id);
  const step = d ? Math.ceil(d.trend.length / (range === "30d" ? 8 : 7)) : 1;

  return (
    <div>
      <Header
        title="用量统计"
        sub={q.dataUpdatedAt ? `每 30 秒自动刷新 · ${timeAgo(new Date(q.dataUpdatedAt).toISOString())}更新` : undefined}
        right={
          <button aria-label="立即刷新" title="立即刷新" onClick={() => void q.refetch()} className="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2">
            <RefreshCw className={cx("size-4", q.isFetching && "animate-spin")} />
          </button>
        }
      />
      <div className="px-4 pb-8 space-y-4">
        <div className="flex flex-wrap gap-2 justify-end">
          <select aria-label="agent" className={selectClass} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">全部 agent</option>
            {d?.filters.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
          <select aria-label="模型" className={selectClass} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">全部模型</option>
            {d?.filters.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select aria-label="时间范围" className={selectClass} value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {!d ? (
          <Loading />
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <StatTile label={d.spendUsd != null ? "费用" : "任务"} value={d.spendUsd != null ? `$${d.spendUsd.toFixed(2)}` : d.totals.runs} />
              <StatTile label="请求" value={d.totals.requests.toLocaleString()} />
              <StatTile label="Tokens" value={tokens(d.totals.input + d.totals.output)} />
              <StatTile label="缓存命中率" value={pct(d.totals.hitRate)} />
              <StatTile size="sm" label="新增输入" value={tokens(d.totals.input - d.totals.cached)} />
              <StatTile size="sm" label="输出" value={tokens(d.totals.output)} />
              <StatTile size="sm" label="缓存命中" value={tokens(d.totals.cached)} />
              <StatTile size="sm" label="推理" value={tokens(d.totals.reasoning)} />
            </div>

            <Card className="p-3.5 space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex-1 text-xs font-medium text-muted">使用趋势 · {RANGES.find((r) => r.value === range)!.label}</div>
                <div className="w-36">
                  <Segmented
                    value={metric}
                    onChange={setMetric}
                    options={[
                      { value: "tokens", label: "Tokens" },
                      { value: "requests", label: "请求" },
                    ]}
                  />
                </div>
              </div>
              <BarChart
                title={metric === "tokens" ? "每段时间的 token 数" : "每段时间的请求数"}
                format={metric === "tokens" ? tokens : (v) => String(Math.round(v))}
                data={d.trend.map((t, i) => ({ label: t.label, tick: (d.trend.length - 1 - i) % step === 0 ? t.label : "", value: t[metric] }))}
              />
            </Card>

            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: "models", label: "模型" },
                { value: "agents", label: "agent" },
                { value: "log", label: "请求日志" },
              ]}
              right={tab === "log" ? "最近 100 条" : "按请求数排序"}
            />

            {d.totals.requests === 0 ? (
              <Empty title="这段时间没有请求" hint="换个时间范围或筛选条件看看" />
            ) : (
              <div className="overflow-x-auto -mx-4 px-4">
                <table className="w-full text-[13px]">
                  {tab === "models" && (
                    <>
                      <thead>
                        <tr className="border-b border-line">
                          <Th>模型</Th>
                          <Th right>请求</Th>
                          <Th right>Tokens</Th>
                          <Th right>缓存命中</Th>
                          <Th right>成功率</Th>
                          <Th right>速度</Th>
                          <Th right>平均耗时</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.models.map((m) => (
                          <tr key={m.model} className="border-b border-line">
                            <Td className="font-mono text-[12.5px]">{m.model}</Td>
                            <Td right>{m.requests}</Td>
                            <Td right>{tokens(m.input + m.output)}</Td>
                            <Td right>{pct(m.input ? m.cached / m.input : null)}</Td>
                            <Td right>{pct(m.successRate)}</Td>
                            <Td right>
                              {m.tps != null ? (
                                <>
                                  {m.tps.toFixed(0)}
                                  <Unit>tok/s</Unit>
                                </>
                              ) : (
                                <Dash />
                              )}
                            </Td>
                            <Td right>{m.avgMs != null ? `${(m.avgMs / 1000).toFixed(1)}s` : <Dash />}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {tab === "agents" && (
                    <>
                      <thead>
                        <tr className="border-b border-line">
                          <Th>agent</Th>
                          <Th right>请求</Th>
                          <Th right>输入</Th>
                          <Th right>输出</Th>
                          <Th right>缓存命中</Th>
                          <Th right>费用</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.agents.map((a) => (
                          <tr key={a.agentId} className="border-b border-line">
                            <Td>
                              <Link to={`/agents/${a.agentId}`} className="hover:underline">
                                {a.emoji} {a.name}
                              </Link>
                            </Td>
                            <Td right>{a.requests}</Td>
                            <Td right>{tokens(a.input)}</Td>
                            <Td right>{tokens(a.output)}</Td>
                            <Td right>{pct(a.input ? a.cached / a.input : null)}</Td>
                            <Td right>{a.spendUsd != null ? `$${a.spendUsd.toFixed(2)}` : <Dash />}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {tab === "log" && (
                    <>
                      <thead>
                        <tr className="border-b border-line">
                          <Th>时间</Th>
                          <Th>agent</Th>
                          <Th>模型</Th>
                          <Th right>输入</Th>
                          <Th right>缓存</Th>
                          <Th right>输出</Th>
                          <Th right>速度</Th>
                          <Th>任务</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.log.map((l, i) => {
                          const a = agentName(l.agentId);
                          return (
                            <tr key={i} className="border-b border-line">
                              <Td className="text-muted">{new Date(l.ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Td>
                              <Td>{a ? `${a.emoji} ${a.name}` : <Dash />}</Td>
                              <Td className="font-mono text-[12.5px]">{l.model}</Td>
                              <Td right>{tokens(l.input)}</Td>
                              <Td right>{tokens(l.cached)}</Td>
                              <Td right>{tokens(l.output)}</Td>
                              <Td right>
                                {l.tps != null ? (
                                  <>
                                    {l.tps.toFixed(0)}
                                    <Unit>tok/s</Unit>
                                  </>
                                ) : (
                                  <Dash />
                                )}
                              </Td>
                              <Td>
                                {l.conversationId ? (
                                  <Link to={`/c/${l.conversationId}`} className={cx("hover:underline", l.status && statusTone(l.status) === "danger" ? "text-danger" : "text-muted")}>
                                    {l.status ? STATUS_TEXT[l.status] : "查看"}
                                  </Link>
                                ) : (
                                  <Dash />
                                )}
                              </Td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}
                </table>
                <div className="pt-2.5 text-xs text-muted">
                  共 {tab === "models" ? d.models.length : tab === "agents" ? d.agents.length : d.log.length} 条记录
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
