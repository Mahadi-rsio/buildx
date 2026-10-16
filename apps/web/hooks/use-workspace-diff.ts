"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffFile, DiffResponse } from "@/lib/types";

export interface DiffState {
  files: DiffFile[];
  status: "loading" | "ready" | "error";
  error: string | null;
  unchanged: number;
  skipped: number;
}

const INITIAL: DiffState = {
  files: [],
  status: "loading",
  error: null,
  unchanged: 0,
  skipped: 0,
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
        const res = await fetch(`/api/workspaces/${workspaceId}/diff`);
        const data = (await res.json()) as
          | DiffResponse
          | { error?: string; message?: string };
        if (!alive) return;
        setState({
          files: res.ok && "files" in data ? data.files : [],
          status:
            res.ok && "files" in data
              ? "ready"
              : res.status === 404
                ? "ready"
                : "error",
          error:
            res.status === 404
              ? null
              : "files" in data
                ? null
                : (data as { message?: string }).message ??
                  (data as { error?: string }).error ??
                  "Failed to load diff",
          unchanged: res.ok && "files" in data ? data.unchanged : 0,
          skipped: res.ok && "files" in data ? data.skipped : 0,
        });
      } catch {
        if (alive) setState({ ...INITIAL, status: "error", error: "Network error" });
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