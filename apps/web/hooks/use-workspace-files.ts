"use client";

import { useCallback, useEffect, useState } from "react";
import type { FileContentResponse, FilesResponse } from "@/lib/types";

export function useWorkspaceFiles(
  workspaceId: string,
  active: boolean,
  /** Poll interval (ms) for the current path while active. 0/undefined = manual. */
  pollMs?: number,
) {
  const [path, setPath] = useState(".");
  const [listing, setListing] = useState<FilesResponse | null>(null);
  const [file, setFile] = useState<FileContentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const requestKey = `${workspaceId}\u0000${path}`;

  const fetchPath = useCallback(
    async (
      target: string,
    ): Promise<
      | { ok: true; data: FilesResponse | FileContentResponse }
      | { ok: false; error: string }
    > => {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(target)}`,
        );
        const data = (await res.json()) as
          | FilesResponse
          | FileContentResponse
          | { error?: string; message?: string };
        if (!res.ok) {
          return {
            ok: false,
            error:
              (data as { message?: string }).message ??
              (data as { error?: string }).error ??
              "Failed to load workspace",
          };
        }
        if ("type" in data && (data.type === "file" || data.type === "dir")) {
          return { ok: true, data };
        }
        return { ok: false, error: "Unexpected workspace response" };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [workspaceId],
  );

  const apply = useCallback(
    (result: Awaited<ReturnType<typeof fetchPath>>) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      if (result.data.type === "file") {
        setFile(result.data);
      } else {
        setListing(result.data);
        setFile(null);
      }
    },
    [],
  );

  const openFile = useCallback(
    async (target: string) => {
      apply(await fetchPath(target));
    },
    [fetchPath, apply],
  );

  const navigate = useCallback((target: string) => {
    setPath(target);
    setFile(null);
  }, []);

  const refresh = useCallback(() => {
    if (file) void openFile(file.path);
    else setRefreshNonce((n) => n + 1);
  }, [file, openFile]);

  const readFileContent = useCallback(
    async (target: string): Promise<string | null> => {
      const result = await fetchPath(target);
      if (!result.ok || result.data.type !== "file") return null;
      if (result.data.binary) return null;
      return result.data.content;
    },
    [fetchPath],
  );

  useEffect(() => {
    if (!active || workspaceId.length === 0) return;
    let alive = true;
    void (async () => {
      const result = await fetchPath(path);
      if (!alive) return;
      apply(result);
      setLoadedKey(requestKey);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, path, active, refreshNonce, fetchPath, apply, requestKey]);

  // Gentle polling so the open panel tracks the agent writing files.
  useEffect(() => {
    if (!active || !pollMs || pollMs < 250) return;
    const id = setInterval(() => {
      setRefreshNonce((n) => n + 1);
    }, pollMs);
    return () => {
      clearInterval(id);
    };
  }, [active, pollMs]);

  const loading =
    active && workspaceId.length > 0 && loadedKey !== requestKey;

  return {
    path,
    listing,
    file,
    loading,
    error,
    navigate,
    openFile,
    refresh,
    backFromFile: () => setFile(null),
    readFileContent,
  };
}
