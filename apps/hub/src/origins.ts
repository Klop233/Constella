import { config } from "./config.ts";
import { kvGet, kvSet, type Db } from "./db.ts";

/**
 * Origins accepted on top of the env list (CONSTELLA_ORIGINS): the address the owner created the account
 * from is remembered, so a fresh deployment opened over Tailscale / a tunnel works without editing .env.
 */
export function extraOrigins(db: Db): string[] {
  try {
    const parsed = JSON.parse(kvGet(db, "settings.extraOrigins") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)) : [];
  } catch {
    return [];
  }
}

export function allowedOrigins(db: Db): string[] {
  return [...config.origins, ...extraOrigins(db).filter((o) => !config.origins.includes(o))];
}

/** Remember an origin the owner used (idempotent; anything that isn't an http(s) origin is ignored). */
export function rememberOrigin(db: Db, origin: string | undefined): void {
  const o = origin?.trim().replace(/\/$/, "");
  if (!o || !/^https?:\/\//.test(o) || allowedOrigins(db).includes(o)) return;
  kvSet(db, "settings.extraOrigins", JSON.stringify([...extraOrigins(db), o]));
}
