"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadConversationPrefs,
  saveConversationPrefs,
  upsertConversationPref,
  type ConversationPrefs,
} from "@/lib/conversation-prefs";

export function useConversationPrefs() {
  const [prefs, setPrefs] = useState<ConversationPrefs>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setPrefs(loadConversationPrefs());
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback((id: string, patch: Parameters<typeof upsertConversationPref>[2]) => {
    setPrefs((current) => {
      const next = upsertConversationPref(current, id, patch);
      saveConversationPrefs(next);
      return next;
    });
  }, []);

  const rename = useCallback(
    (id: string, title: string) => update(id, { title }),
    [update],
  );

  const togglePin = useCallback(
    (id: string) => {
      setPrefs((current) => {
        const pinned = !current[id]?.pinned;
        const next = upsertConversationPref(current, id, { pinned });
        saveConversationPrefs(next);
        return next;
      });
    },
    [],
  );

  const hide = useCallback(
    (id: string) => update(id, { hidden: true }),
    [update],
  );

  return { prefs, ready, rename, togglePin, hide, update };
}
