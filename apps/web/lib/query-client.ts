"use client";

import {
  QueryClient,
  type DefaultOptions,
} from "@tanstack/react-query";

export const QUERY_CACHE_KEY = "buildx.query-cache.v1";
export const QUERY_CACHE_OWNER_KEY = "buildx.query-cache.owner.v1";
export const QUERY_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

const defaultOptions: DefaultOptions = {
  queries: {
    staleTime: 15_000,
    gcTime: QUERY_CACHE_MAX_AGE_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  },
};

function createClient(): QueryClient {
  return new QueryClient({ defaultOptions });
}

let browserClient: QueryClient | undefined;

/** One QueryClient per browser tab; a fresh one for each SSR render. */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return createClient();
  browserClient ??= createClient();
  return browserClient;
}

export function readQueryCacheOwner(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(QUERY_CACHE_OWNER_KEY);
  } catch {
    return null;
  }
}

export function writeQueryCacheOwner(userId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) window.localStorage.setItem(QUERY_CACHE_OWNER_KEY, userId);
    else window.localStorage.removeItem(QUERY_CACHE_OWNER_KEY);
  } catch {
    // Ignore storage failures: owner tracking is best effort.
  }
}

/** Drop persisted/memory cache (logout, account switch). */
export function clearQueryCache(client: QueryClient): void {
  client.clear();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(QUERY_CACHE_KEY);
  } catch {
    // Ignore.
  }
}
