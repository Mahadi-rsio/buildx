"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunSummary } from "@/lib/types";

export function useRuns(pollMs = 4000) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const res = await fetch("/api/runs");
        const data = (await res.json()) as { runs?: RunSummary[] };
        if (!alive) return;
        setRuns(data.runs ?? []);
        setError(null);
      } catch {
        if (alive) setError("Could not load conversations");
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pollMs, refreshNonce]);

  return { runs, loading, error, refresh };
}
