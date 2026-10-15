import type { RunSummary } from "@/lib/types";
import {
  displayTitle,
  type ConversationPref,
  type ConversationPrefs,
} from "@/lib/conversation-prefs";

export interface RunListItem extends RunSummary {
  title: string;
  pinned: boolean;
}

export interface RunGroup {
  id: string;
  label: string;
  items: RunListItem[];
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupLabel(dayStart: number, now: number): string {
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  if (dayStart === today) return "Today";
  if (dayStart === yesterday) return "Yesterday";
  const days = Math.floor((today - dayStart) / 86_400_000);
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return new Date(dayStart).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export function prepareRunList(
  runs: RunSummary[],
  prefs: ConversationPrefs,
  query: string,
): { pinned: RunListItem[]; groups: RunGroup[] } {
  const q = query.trim().toLowerCase();
  const visible = runs
    .filter((run) => !prefs[run.id]?.hidden)
    .map((run) => {
      const pref: ConversationPref | undefined = prefs[run.id];
      return {
        ...run,
        title: displayTitle(run.task, pref),
        pinned: Boolean(pref?.pinned),
      } satisfies RunListItem;
    })
    .filter((run) => {
      if (!q) return true;
      return (
        run.title.toLowerCase().includes(q) ||
        run.task.toLowerCase().includes(q) ||
        run.id.toLowerCase().includes(q) ||
        run.model.toLowerCase().includes(q)
      );
    });

  const pinned = visible
    .filter((run) => run.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const unpinned = visible
    .filter((run) => !run.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const now = Date.now();
  const groupMap = new Map<string, RunGroup>();
  for (const run of unpinned) {
    const day = startOfDay(run.updatedAt);
    const id = String(day);
    const existing = groupMap.get(id);
    if (existing) {
      existing.items.push(run);
    } else {
      groupMap.set(id, {
        id,
        label: groupLabel(day, now),
        items: [run],
      });
    }
  }

  // Collapse identical labels (e.g. multiple days in "Previous 7 days")
  const collapsed: RunGroup[] = [];
  for (const group of groupMap.values()) {
    const last = collapsed.at(-1);
    if (last && last.label === group.label) {
      last.items.push(...group.items);
    } else {
      collapsed.push(group);
    }
  }

  return { pinned, groups: collapsed };
}
