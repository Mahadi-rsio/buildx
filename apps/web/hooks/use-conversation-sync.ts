"use client";

import { useEffect } from "react";
import {
  flushConversationSync,
  requestConversationSync,
  SYNC_INTERVAL_MS,
  SYNC_REQUEST_EVENT,
} from "@/lib/conversation-sync";

/**
 * Drives the 30s conversation sync loop plus best-effort flushes on tab
 * hide/unload, reconnect, and explicit enqueue requests. `beforeunload` alone
 * is unreliable, so visibilitychange/pagehide are the primary unload hooks.
 */
export function useConversationSync(): void {
  useEffect(() => {
    const flush = () => {
      void flushConversationSync();
    };

    flush();
    const timer = window.setInterval(flush, SYNC_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const onPageHide = () => flush();
    const onOnline = () => flush();
    const onRequest = () => flush();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    window.addEventListener(SYNC_REQUEST_EVENT, onRequest);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      window.removeEventListener(SYNC_REQUEST_EVENT, onRequest);
    };
  }, []);
}

export { requestConversationSync };
