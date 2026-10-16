/**
 * Unsent composer text, per conversation (or per agent for a new one), kept in this browser so switching away or
 * the phone killing the app doesn't lose it. Storage may be unavailable (private mode): then drafts just don't stick.
 */
const PREFIX = "constella.draft.";

export function draftKey(conversationId: string | undefined, agentId: string | undefined): string | null {
  return conversationId ? `${PREFIX}c.${conversationId}` : agentId ? `${PREFIX}new.${agentId}` : null;
}

export function readDraft(key: string | null): string {
  if (!key) return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string | null, text: string): void {
  if (!key) return;
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // storage full or blocked: the draft only lives in the page
  }
}
