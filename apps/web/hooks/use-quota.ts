"use client";

import { useQuery } from "@tanstack/react-query";

export interface QuotaSnapshot {
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  const res = await fetch("/api/quota", { cache: "no-store" });
  if (res.status === 503) {
    throw new Error("Usage tracking is temporarily unavailable");
  }
  if (!res.ok) throw new Error(`quota request failed (${res.status})`);
  return (await res.json()) as QuotaSnapshot;
}

export function quotaQueryKey() {
  return ["quota"] as const;
}

export function useQuota(enabled = true) {
  return useQuery({
    queryKey: quotaQueryKey(),
    queryFn: fetchQuota,
    enabled,
    staleTime: 10_000,
  });
}
