"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EventType, RunEvent, RunStatus } from "@buildx/shared";
import { isTerminalStatus } from "@buildx/shared";
import type { RunDetail } from "@/lib/types";

const EVENT_TYPES: EventType[] = [
  "status",
  "text",
  "tool_call",
  "tool_result",
  "terminal",
  "file_change",
  "todo",
  "approval",
  "error",
  "workspace",
];

interface Frame {
  ts: number;
  data: unknown;
}

export function useRunStream(runId: string) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const lastIdRef = useRef(0);

  useEffect(() => {
    if (runId.length === 0) return;
    let alive = true;
    let source: EventSource | null = null;

    const attach = (startAt: number, terminal: boolean) => {
      if (!alive || terminal) return;
      const url = `/api/runs/${runId}/stream?after=${startAt}`;
      source = new EventSource(url);

      const listeners = EVENT_TYPES.map((type) => {
        const handler = (event: MessageEvent<string>) => {
          if (!alive) return;
          let frame: Frame;
          try {
            frame = JSON.parse(event.data) as Frame;
          } catch {
            return;
          }
          const id = Number(event.lastEventId);
          if (Number.isFinite(id) && id > 0) {
            if (id <= lastIdRef.current) return;
            lastIdRef.current = id;
          }
          const next = {
            id: Number.isFinite(id) && id > 0 ? id : 0,
            runId,
            ts: frame.ts,
            type,
            data: frame.data,
          } as RunEvent;
          setEvents((previous) => [...previous, next]);

          if (type === "status") {
            const payload = frame.data as {
              status: RunStatus;
              message?: string;
            };
            setRun((previous) =>
              previous
                ? {
                    ...previous,
                    status: payload.status,
                    error:
                      payload.status === "failed"
                        ? payload.message ?? previous.error
                        : previous.error,
                    updatedAt: frame.ts,
                  }
                : previous,
            );
            if (isTerminalStatus(payload.status)) {
              source?.close();
              // Stats (including real token usage) are only persisted once the
              // run finishes, so pull the final record to surface them.
              void (async () => {
                try {
                  const res = await fetch(`/api/runs/${runId}`);
                  if (!res.ok || !alive) return;
                  const data = (await res.json()) as RunDetail;
                  if (!alive) return;
                  setRun((previous) =>
                    previous
                      ? {
                          ...previous,
                          status: data.status,
                          error: data.error ?? previous.error,
                          stats: data.stats,
                          updatedAt: data.updatedAt,
                        }
                      : data,
                  );
                } catch {
                  // Keep the streamed state if the refresh fails.
                }
              })();
            }
          } else if (type === "error") {
            const payload = frame.data as { message?: string };
            setRun((previous) =>
              previous
                ? { ...previous, error: payload.message ?? previous.error }
                : previous,
            );
          } else if (type === "workspace") {
            const payload = frame.data as RunDetail["workspace"];
            setRun((previous) =>
              previous
                ? {
                    ...previous,
                    workspace: {
                      ...previous.workspace,
                      ...payload,
                    },
                    workspaceId:
                      payload.workspaceId && payload.workspaceId.length > 0
                        ? payload.workspaceId
                        : previous.workspaceId,
                  }
                : previous,
            );
          }
        };
        source?.addEventListener(type, handler as EventListener);
        return () =>
          source?.removeEventListener(type, handler as EventListener);
      });

      source.onerror = () => {
        if (source && source.readyState === EventSource.CLOSED && alive) {
          setStreamError("Stream closed — refresh to resume");
        }
      };

      return () => {
        for (const off of listeners) off();
        source?.close();
      };
    };

    let detach: (() => void) | undefined;

    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setLoading(true);
      setNotFound(false);
      setStreamError(null);
      setRun(null);
      setEvents([]);
      lastIdRef.current = 0;
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) {
          if (alive) {
            setNotFound(true);
            setLoading(false);
          }
          return;
        }
        const data = (await res.json()) as RunDetail;
        if (!alive) return;
        setRun(data);
        setEvents(data.events);
        const last = data.events.at(-1);
        lastIdRef.current = last?.id ?? 0;
        detach = attach(lastIdRef.current, isTerminalStatus(data.status));
        setLoading(false);
      } catch {
        if (alive) {
          setStreamError("Could not reach the run API");
          setLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
      detach?.();
      source?.close();
    };
  }, [runId]);

  const stop = useCallback(async () => {
    await fetch(`/api/runs/${runId}/stop`, { method: "POST" }).catch(
      () => undefined,
    );
  }, [runId]);

  return {
    run,
    events,
    streamError,
    notFound,
    loading,
    stop,
  };
}
