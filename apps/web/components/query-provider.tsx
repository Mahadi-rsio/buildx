"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { useSession } from "@/lib/auth/client";
import {
  clearQueryCache,
  getQueryClient,
  QUERY_CACHE_KEY,
  QUERY_CACHE_MAX_AGE_MS,
  readQueryCacheOwner,
  writeQueryCacheOwner,
} from "@/lib/query-client";
import { clearPendingConversationQueue } from "@/lib/conversation-sync";

/**
 * Clears persisted data whenever the signed-in user changes so a shared
 * browser never shows one account's cached conversations to another.
 */
function SessionCacheGuard(): null {
  const queryClient = getQueryClient();
  const { data, isPending } = useSession();

  useEffect(() => {
    if (isPending) return;
    const userId = data?.user?.id ?? null;
    const owner = readQueryCacheOwner();
    if (owner !== userId) {
      clearQueryCache(queryClient);
      writeQueryCacheOwner(userId);
      if (owner && !userId) clearPendingConversationQueue();
      else if (owner && userId && owner !== userId)
        clearPendingConversationQueue();
    } else if (!owner && userId) {
      writeQueryCacheOwner(userId);
    }
  }, [data, isPending, queryClient]);

  return null;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const persister = useMemo(() => {
    if (typeof window === "undefined") return null;
    return createSyncStoragePersister({
      storage: window.localStorage,
      key: QUERY_CACHE_KEY,
      throttleTime: 1_000,
    });
  }, []);

  if (!persister) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionCacheGuard />
        {children}
      </QueryClientProvider>
    );
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: QUERY_CACHE_MAX_AGE_MS,
        buster: "v1",
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => query.state.status === "success",
        },
      }}
    >
      <SessionCacheGuard />
      {children}
    </PersistQueryClientProvider>
  );
}
