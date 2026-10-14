import { useEffect, useRef, useState } from "react";

export interface HeatDay {
  day: string;
  tokens: number;
  requests: number;
}

const LEVELS = [0, 0.28, 0.5, 0.75, 1];
const CELL = 12;
const GAP = 3;
const LEFT = 26;
const TOP = 16;

/** GitHub-style contribution grid: one column per week (Sunday first), intensity by quartile of non-zero days. */
export function ActivityHeatmap({ days, metric, format }: { days: HeatDay[]; metric: "tokens" | "requests"; format: (v: number) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [days]);

  const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
  const lead = days[0] ? weekday(days[0].day) : 0;
  const cells = days.map((d, i) => ({ ...d, col: Math.floor((i + lead) / 7), row: (i + lead) % 7, value: d[metric] }));
  const cols = (cells.at(-1)?.col ?? 0) + 1;
  const sorted = cells.map((c) => c.value).filter((v) => v > 0).sort((a, b) => a - b);
  const cut = [0.25, 0.5, 0.75].map((p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0);
  const level = (v: number) => (v <= 0 ? 0 : v <= cut[0]! ? 1 : v <= cut[1]! ? 2 : v <= cut[2]! ? 3 : 4);
  const fill = (l: number) => (l === 0 ? "var(--surface-2)" : `color-mix(in srgb, var(--color-accent) ${LEVELS[l]! * 100}%, transparent)`);

  const months: { col: number; label: string }[] = [];
  let last = "";
  for (const c of cells) {
    const m = c.day.slice(0, 7);
    if (c.row === 0 && m !== last && c.col > 0) months.push({ col: c.col, label: `${Number(c.day.slice(5, 7))}月` });
    if (c.row === 0) last = m;
  }

  const width = LEFT + cols * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const h = cells.find((c) => c.day === hover);
  const total = cells.reduce((n, c) => n + c.value, 0);
  const active = cells.filter((c) => c.value > 0).length;

  return (
    <div>
      <div ref={scroller} className="overflow-x-auto pb-1">
        <div className="relative" style={{ width, minWidth: width }}>
          <svg width={width} height={height} role="img" aria-label={`过去一年每天的${metric === "tokens" ? " token 数" : "请求数"}`} onPointerLeave={() => setHover(null)}>
            {months.map((m) => (
              <text key={m.col} x={LEFT + m.col * (CELL + GAP)} y={10} fontSize="10" fill="var(--muted)">
                {m.label}
              </text>
            ))}
            {[1, 3, 5].map((r) => (
              <text key={r} x={0} y={TOP + r * (CELL + GAP) + CELL - 2} fontSize="10" fill="var(--muted)">
                {["日", "一", "二", "三", "四", "五", "六"][r]}
              </text>
            ))}
            {cells.map((c) => (
              <rect
                key={c.day}
                x={LEFT + c.col * (CELL + GAP)}
                y={TOP + c.row * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={3}
                fill={fill(level(c.value))}
                stroke={hover === c.day ? "var(--text)" : "none"}
                onPointerEnter={() => setHover(c.day)}
                onPointerDown={() => setHover(c.day)}
              />
            ))}
          </svg>
        </div>
      </div>
      <div className="flex items-center gap-3 pt-1.5 text-xs text-muted">
        <div className="flex-1 truncate tabular-nums">
          {h ? `${h.day} · ${format(h.value)}${metric === "tokens" ? " tokens" : " 次请求"}` : `${active} 天有活动 · 共 ${format(total)}${metric === "tokens" ? " tokens" : " 次请求"}`}
        </div>
        <div className="flex items-center gap-1">
          少
          {LEVELS.map((_, l) => (
            <span key={l} className="inline-block rounded-[3px]" style={{ width: CELL, height: CELL, background: fill(l) }} />
          ))}
          多
        </div>
      </div>
    </div>
  );
}
