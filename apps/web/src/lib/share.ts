/** What another app shared into Constella (kept by the service worker), and the hand-off to the chat page. */
const SHARE_CACHE = "constella-share";

export interface Shared {
  text: string;
  files: File[];
}

/** Reads (without clearing) what was shared; null when there is nothing. */
export async function readShared(): Promise<Shared | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const meta = await cache.match("/share-meta");
    if (!meta) return null;
    const m = (await meta.json()) as { title: string; text: string; url: string; files: { name: string; type: string; path: string }[] };
    const files: File[] = [];
    for (const f of m.files) {
      const res = await cache.match(f.path);
      if (res) files.push(new File([await res.blob()], f.name || "shared", { type: f.type }));
    }
    // Apps put the link in `text`, `url`, or both; say each thing once.
    const parts = [m.title, m.text, m.url].map((x) => x.trim()).filter(Boolean);
    const text = parts.filter((p, i) => !parts.some((q, j) => j !== i && q.includes(p) && (q.length > p.length || j < i))).join("\n");
    return text || files.length ? { text, files } : null;
  } catch {
    return null;
  }
}

export async function clearShared(): Promise<void> {
  try {
    await caches.delete(SHARE_CACHE);
  } catch {}
}

/** Files waiting for the chat page of the agent they were shared to. */
let pending: { agentId: string; files: File[] } | null = null;

export function handOffFiles(agentId: string, files: File[]): void {
  pending = files.length ? { agentId, files } : null;
}

export function takeFiles(agentId: string | undefined): File[] {
  if (!pending || pending.agentId !== agentId) return [];
  const files = pending.files;
  pending = null;
  return files;
}
