import { useSyncExternalStore } from "react";

/** Which instance the floating window shows (one at a time), kept across page changes and reloads of this tab. */
const KEY = "constella.instanceWindow";
let current: string | null = read();
const subs = new Set<() => void>();

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function set(id: string | null) {
  if (id === current) return;
  current = id;
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private mode etc.: the window just won't survive a reload.
  }
  for (const f of subs) f();
}

export function openInstanceWindow(id: string): void {
  set(id);
}

/** Closes the window; with an id, only if it shows that instance. */
export function closeInstanceWindow(id?: string): void {
  if (!id || current === id) set(null);
}

export function useInstanceWindow(): string | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
}
