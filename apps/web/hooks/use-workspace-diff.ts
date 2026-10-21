"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffFallbackFile, DiffFile, DiffResponse } from "@/lib/types";

export interface DiffState {
  files: DiffFile[];
  status: "loading" | "ready" | "error";
  error: string | null;
  unchanged: number;
  skipped: number;
  fallbackFiles: DiffFallbackFile[];
}

const INITIAL: DiffState = {
  files: [],
  status: "loading",
  error: null,
  unchanged: 0,
  skipped: 0,
  fallbackFiles: [],
};

/**
 * Poll `GET /api/workspaces/:id/diff` while the run streams so the Changes tab
 * tracks the agent as it writes. Pauses when the panel is hidden or the run is
 * terminal (a manual `refresh` still re-checks once for final numbers).
 */
export function useWorkspaceDiff(
  workspaceId: string,
  active: boolean,
  pollMs?: number,
) {
  const [state, setState] = useState<DiffState>(INITIAL);
  const [nonce, setNonce] = useState(0);
  const mountedRef = useRef(false);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || workspaceId.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/diff`, {
          signal: AbortSignal.timeout(20_000),
        });
        const data = (await res.json()) as
          | DiffResponse
          | {
              error?: string;
              message?: string;
              fallbackFiles?: DiffFallbackFile[];
            };
        if (!alive) return;
        const ok = res.ok && "files" in data;
        const fallbackFiles =
          "fallbackFiles" in data ? (data.fallbackFiles ?? []) : [];
        setState({
          files: ok ? data.files : [],
          status: ok ? "ready" : res.status === 404 ? "ready" : "error",
          error: ok
            ? null
            : res.status === 404
              ? null
              : "message" in data && data.message
                ? data.message
                : "error" in data && data.error
                  ? data.error
                  : "Failed to load diff",
          unchanged: ok ? data.unchanged : 0,
          skipped: ok ? data.skipped : 0,
          fallbackFiles,
        });
      } catch (error) {
        if (!alive) return;
        const timedOut =
          error instanceof DOMException && error.name === "TimeoutError";
        setState({
          ...INITIAL,
          status: "error",
          error: timedOut
            ? "The diff is taking too long."
            : "Network error",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, active, nonce]);

  useEffect(() => {
    if (!active || !pollMs || pollMs < 250) return;
    const id = setInterval(() => {
      if (mountedRef.current) setNonce((n) => n + 1);
    }, pollMs);
    return () => clearInterval(id);
  }, [active, pollMs]);

  return { ...state, refresh };
}