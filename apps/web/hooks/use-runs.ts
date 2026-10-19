"use client";

import { useQuery } from "@tanstack/react-query";
import type { RunSummary } from "@/lib/types";

async function fetchRuns(): Promise<RunSummary[]> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`runs request failed (${res.status})`);
  const data = (await res.json()) as { runs?: RunSummary[] };
  return data.runs ?? [];
}

export function runsQueryKey() {
  return ["runs"] as const;
}

export function useRuns(pollMs = 4000) {
  const query = useQuery({
    queryKey: runsQueryKey(),
    queryFn: fetchRuns,
    refetchInterval: pollMs,
  });

  return {
    runs: query.data ?? [],
    loading: query.isLoading,
    error: query.error ? "Could not load conversations" : null,
    refresh: () => void query.refetch(),
  };
}
