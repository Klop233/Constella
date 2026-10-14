import { useSyncExternalStore } from "react";

/** Per-device display preferences, kept in localStorage and applied as attributes on <html>. */
export interface Appearance {
  theme: "system" | "light" | "dark";
  palette: "nebula" | "clay" | "ocean";
  font: "sans" | "serif";
  /** Show context / token / speed stats in conversations. */
  usage: boolean;
  /** Sidebar entries (route paths) tucked under 更多. */
  navFolded: string[];
}

const KEY = "constella:appearance";
const DEFAULTS: Appearance = { theme: "system", palette: "nebula", font: "sans", usage: true, navFolded: ["/artifacts", "/audit", "/usage", "/reflect"] };
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): Appearance {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") } as Appearance;
    // The 桌面 page became 实例 (/instances).
    return { ...saved, navFolded: saved.navFolded.map((p) => (p === "/desktops" ? "/instances" : p)) };
  } catch {
    return DEFAULTS;
  }
}

let current = read();

function apply(): void {
  const root = document.documentElement;
  root.dataset.mode = current.theme === "system" ? (dark.matches ? "dark" : "light") : current.theme;
  root.dataset.palette = current.palette;
  root.dataset.font = current.font;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

export function setAppearance(patch: Partial<Appearance>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode etc.: the choice just won't survive a reload.
  }
  apply();
  for (const l of listeners) l();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

dark.addEventListener("change", () => current.theme === "system" && apply());
apply();
