/** Client-only UI prefs for runs (no backend rename/pin/delete yet). */

export interface ConversationPref {
  title?: string;
  pinned?: boolean;
  hidden?: boolean;
}

export type ConversationPrefs = Record<string, ConversationPref>;

const STORAGE_KEY = "buildx.conversation-prefs";

export function loadConversationPrefs(): ConversationPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ConversationPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveConversationPrefs(prefs: ConversationPrefs): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function upsertConversationPref(
  prefs: ConversationPrefs,
  id: string,
  patch: Partial<ConversationPref>,
): ConversationPrefs {
  const current = prefs[id] ?? {};
  const next = { ...current, ...patch };
  const cleaned: ConversationPref = {};
  if (next.title?.trim()) cleaned.title = next.title.trim();
  if (next.pinned) cleaned.pinned = true;
  if (next.hidden) cleaned.hidden = true;
  const result = { ...prefs };
  if (Object.keys(cleaned).length === 0) delete result[id];
  else result[id] = cleaned;
  return result;
}

export function displayTitle(
  task: string,
  pref?: ConversationPref,
  max = 72,
): string {
  const title = pref?.title?.trim() || task.trim();
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}
