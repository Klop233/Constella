import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { BarChart } from "../components/BarChart";
import { Card, Empty, Header, Loading, Segmented, Select, cx, toast } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";

interface ReflectData {
  stats: {
    days: number;
    conversations: number;
    runs: number;
    minutes: number;
    topWeekday: number | null;
    topHour: number | null;
    series: { day: string; conversations: number; runs: number; minutes: number }[];
  };
  summary: { headline: string; body: string; generatedAt: string; model: string } | null;
}

const PERIODS = [
  { value: "7", label: "过去一周" },
  { value: "30", label: "过去一个月" },
  { value: "90", label: "过去三个月" },
] as const;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="font-display text-2xl font-medium tabular-nums truncate">{value}</div>
      <div className="text-[11px] tracking-wide text-muted mt-0.5">{label}</div>
    </div>
  );
}

function minutesText(m: number): string {
  return m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} 小时` : `${m} 分钟`;
}

export default function Reflect() {
  const qc = useQueryClient();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [metric, setMetric] = useState<"conversations" | "minutes">("conversations");
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["reflect", days], queryFn: () => api.get<ReflectData>(`/api/reflect?days=${days}`) });

  const regenerate = async () => {
    setBusy(true);
    try {
      await api.post(`/api/reflect/summary?days=${days}`);
      await qc.invalidateQueries({ queryKey: ["reflect", days] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  const s = data?.stats;
  const step = s ? Math.ceil(s.series.length / 8) : 1;
  return (
    <div>
      <Header
        title="回顾"
        sub="根据你和 agent 们的对话"
        right={
          <Select label="时间范围" className="w-32" value={days} options={[...PERIODS]} onChange={setDays} />
        }
      />
      {isLoading || !s ? (
        <Loading />
      ) : s.runs === 0 ? (
        <Empty icon={<Sparkles className="size-6" />} title="这段时间还没有对话" hint="和 agent 聊几次之后再来看看" />
      ) : (
        <div className="px-4 pb-8 space-y-6 lg:max-w-3xl">
          <section className="space-y-2 pt-1">
            {data.summary ? (
              <>
                <h1 className="font-display text-xl font-semibold leading-snug">{data.summary.headline}</h1>
                <p className="text-[14px] leading-relaxed text-[color-mix(in_oklab,var(--text)_85%,transparent)]">{data.summary.body}</p>
              </>
            ) : (
              <p className="text-[13.5px] text-muted">还没有生成这段时间的总结。</p>
            )}
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              {data.summary && (
                <span>
                  {timeAgo(data.summary.generatedAt)}由 {data.summary.model} 生成
                </span>
              )}
              <button onClick={regenerate} disabled={busy} className="flex items-center gap-1 h-6 px-1.5 rounded hover:bg-surface-2 hover:text-[var(--text)]">
                <RefreshCw className={cx("size-3.5", busy && "animate-spin")} />
                {busy ? "生成中…" : data.summary ? "重新生成" : "生成总结"}
              </button>
            </div>
          </section>

          <section className="grid grid-cols-3 gap-4">
            <Stat value={s.topWeekday != null ? WEEKDAYS[s.topWeekday]! : "—"} label="最活跃的一天" />
            <Stat value={s.topHour != null ? `${s.topHour}:00` : "—"} label="高峰时段" />
            <Stat value={String(s.conversations)} label="对话总数" />
          </section>

          <Card className="p-3.5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 text-xs font-medium text-muted">
                你和 agent 们的时间 · {s.runs} 次任务 · 共 {minutesText(s.minutes)}
              </div>
              <div className="w-36">
                <Segmented
                  value={metric}
                  onChange={setMetric}
                  options={[
                    { value: "conversations", label: "对话" },
                    { value: "minutes", label: "用时" },
                  ]}
                />
              </div>
            </div>
            <BarChart
              title={metric === "conversations" ? "每天的对话数" : "每天 agent 干活的分钟数"}
              format={metric === "conversations" ? (v) => String(Math.round(v)) : (v) => `${Math.round(v)} 分`}
              data={s.series.map((d, i) => ({
                label: d.day.slice(5).replace("-", "/"),
                tick: (s.series.length - 1 - i) % step === 0 ? d.day.slice(5).replace("-", "/") : "",
                value: d[metric],
              }))}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
