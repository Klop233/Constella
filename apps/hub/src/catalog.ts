import { z } from "zod";
import { kvGet, kvSet, type Db } from "./db.ts";

/** A Codex reasoning level; which ones exist depends on the model (see EffortCatalog). */
export const EffortSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/);
export type Effort = string;

/** Reasoning levels from weakest to strongest; each model supports a subset. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface ModelEfforts {
  /** Supported levels, weakest first; empty when the model has no adjustable reasoning. */
  efforts: string[];
  /** What Codex uses when no level is set; null when unknown. */
  defaultEffort: string | null;
}

/** Models Codex has no metadata for (most non-OpenAI ones): the levels every reasoning API understands. */
const FALLBACK: ModelEfforts = { efforts: ["low", "medium", "high"], defaultEffort: null };

const KEY = "codex.models";

/** The reasoning levels each model supports, as the agents' Codex reports them; kept in kv across hub restarts. */
export class EffortCatalog {
  #db: Db;
  #models: Record<string, ModelEfforts>;

  constructor(db: Db) {
    this.#db = db;
    try {
      this.#models = JSON.parse(kvGet(db, KEY) ?? "{}");
    } catch {
      this.#models = {};
    }
  }

  update(models: ({ id: string } & ModelEfforts)[]): void {
    const next = Object.fromEntries(models.map((m) => [m.id, { efforts: m.efforts, defaultEffort: m.defaultEffort }]));
    const json = JSON.stringify(next);
    if (json === JSON.stringify(this.#models)) return;
    this.#models = next;
    kvSet(this.#db, KEY, json);
  }

  get(model: string): ModelEfforts {
    return this.#models[model] ?? FALLBACK;
  }

  /** `effort` if the model supports it, else the strongest supported level below it (else the weakest); undefined when none apply. */
  fit(model: string, effort: string): string | undefined {
    const { efforts } = this.get(model);
    if (efforts.includes(effort)) return effort;
    if (!efforts.length) return undefined;
    const rank = EFFORT_ORDER.indexOf(effort);
    if (rank < 0) return effort;
    return efforts.filter((e) => EFFORT_ORDER.indexOf(e) >= 0 && EFFORT_ORDER.indexOf(e) <= rank).at(-1) ?? efforts[0];
  }
}
