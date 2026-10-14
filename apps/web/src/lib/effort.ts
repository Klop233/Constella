import type { ModelEntry } from "./models";
import type { Effort } from "./types";

const LABELS: Record<string, string> = { none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超强" };
/** Reasoning levels from weakest to strongest (the hub's EFFORT_ORDER). */
const ORDER = Object.keys(LABELS);

export const effortLabel = (e: Effort) => LABELS[e] ?? e;

/** The levels a model supports; the hub answers for every model it lists, so this only fills in while loading. */
export function modelEfforts(models: ModelEntry[] | undefined, ref: string): Pick<ModelEntry, "efforts" | "defaultEffort"> {
  const m = models?.find((x) => x.ref === ref);
  return m ?? { efforts: ["low", "medium", "high"], defaultEffort: null };
}

/** Index of the level the hub actually uses for `effort`: itself, else the strongest supported one below it, else the weakest. */
export function fitIndex(levels: Effort[], effort: Effort): number {
  const i = levels.indexOf(effort);
  if (i >= 0) return i;
  const rank = ORDER.indexOf(effort);
  let best = 0;
  levels.forEach((l, j) => {
    const r = ORDER.indexOf(l);
    if (r >= 0 && r <= rank) best = j;
  });
  return best;
}
