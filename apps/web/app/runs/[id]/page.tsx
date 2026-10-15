"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EventType, RunEvent, RunStatus } from "@buildx/shared";
import { isTerminalStatus } from "@buildx/shared";
import {
  ArrowLeft,
  Coins,
  Hash,
  Square,
} from "lucide-react";
import {
  EventRow,
  latestTodos,
  TodoList,
  toStreamItems,
} from "@/components/run-events";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { WorkspaceBrowser } from "@/components/workspace-browser";
import { formatAgo } from "@/lib/format";
import type {
  FileContentResponse,
  FilesResponse,
  RunDetail,
} from "@/lib/types";

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
];

interface Frame {
  ts: number;
  data: unknown;
}

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const runId = params?.id ?? "";

  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [listing, setListing] = useState<FilesResponse | null>(null);
  const [file, setFile] = useState<FileContentResponse | null>(null);
  const [path, setPath] = useState(".");
  const [filesError, setFilesError] = useState<string | null>(null);

  const lastIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => toStreamItems(events), [events]);
  const todos = useMemo(() => latestTodos(events), [events]);
  const terminalChunks = useMemo(
    () =>
      items
        .filter(
          (item): item is Extract<typeof item, { kind: "terminal" }> =>
            item.kind === "terminal",
        )
        .map((item) => item.chunk)
        .join(""),
    [items],
  );
  const workspaceId = run?.workspaceId ?? runId;
  const status = run?.status ?? "queued";
  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchFiles = useCallback(
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
              "failed to load workspace",
          };
        }
        if ("type" in data && (data.type === "file" || data.type === "dir")) {
          return { ok: true, data };
        }
        return { ok: false, error: "unexpected workspace response" };
      } catch {
        return { ok: false, error: "network error" };
      }
    },
    [workspaceId],
  );

  const applyFiles = useCallback(
    (result: Awaited<ReturnType<typeof fetchFiles>>) => {
      if (!result.ok) {
        setFilesError(result.error);
        return;
      }
      setFilesError(null);
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
      applyFiles(await fetchFiles(target));
    },
    [fetchFiles, applyFiles],
  );

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
            }
          } else if (type === "error") {
            const payload = frame.data as { message?: string };
            setRun((previous) =>
              previous
                ? { ...previous, error: payload.message ?? previous.error }
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
          setStreamError("stream closed — refresh to resume");
        }
      };
      return () => {
        for (const off of listeners) off();
        source?.close();
      };
    };

    let detach: (() => void) | undefined;

    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) {
          if (alive) setNotFound(true);
          return;
        }
        const data = (await res.json()) as RunDetail;
        if (!alive) return;
        setRun(data);
        setEvents(data.events);
        const last = data.events.at(-1);
        lastIdRef.current = last?.id ?? 0;
        detach = attach(lastIdRef.current, isTerminalStatus(data.status));
      } catch {
        if (alive) setStreamError("could not reach the run API");
      }
    })();

    return () => {
      alive = false;
      detach?.();
      source?.close();
    };
  }, [runId]);

  useEffect(() => {
    if (workspaceId.length === 0) return;
    let alive = true;
    void (async () => {
      const result = await fetchFiles(path);
      if (!alive) return;
      applyFiles(result);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, path, status, refreshNonce, fetchFiles, applyFiles]);

  const refresh = useCallback(() => {
    if (file) void openFile(file.path);
    else setRefreshNonce((nonce) => nonce + 1);
  }, [file, openFile]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 160) element.scrollTop = element.scrollHeight;
  }, [items.length]);

  const stop = useCallback(async () => {
    await fetch(`/api/runs/${runId}/stop`, { method: "POST" }).catch(
      () => undefined,
    );
  }, [runId]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-border bg-card/50 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Run <code className="font-mono text-foreground">{runId}</code> no
          longer exists.
        </p>
        <Button
          render={<Link href="/" />}
          nativeButton={false}
          variant="outline"
          className="mt-4"
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-[520px] flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Button
            render={<Link href="/" />}
            nativeButton={false}
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground"
          >
            <ArrowLeft className="size-3.5" />
            All runs
          </Button>
          <h1 className="max-w-3xl break-words text-lg font-semibold leading-snug tracking-tight">
            {run?.task ?? "Loading run…"}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={status} />
            <Separator orientation="vertical" className="hidden h-3 sm:block" />
            <span className="inline-flex items-center gap-1 font-mono">
              <Hash className="size-3" />
              {runId.slice(0, 10)}
            </span>
            {run ? <span className="font-mono">{run.model}</span> : null}
            {run ? (
              <span className="inline-flex items-center gap-1">
                <Coins className="size-3" />
                {run.stats?.usage?.totalTokens ?? 0} tokens
              </span>
            ) : null}
            {run ? <span>{run.stats?.steps ?? 0} steps</span> : null}
            {run ? <span>{formatAgo(run.createdAt)}</span> : null}
            <span className="font-mono">{events.length} events</span>
          </div>
        </div>
        {!isTerminalStatus(status) ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void stop()}
          >
            <Square className="size-3.5" />
            Stop run
          </Button>
        ) : null}
      </div>

      {run?.error ? (
        <Alert variant="destructive">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      ) : null}
      {streamError ? (
        <Alert className="border-amber-500/30 bg-amber-500/10">
          <AlertTitle className="text-amber-100">Stream interrupted</AlertTitle>
          <AlertDescription className="text-amber-100/80">
            {streamError}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card/30">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize="62" minSize="35" className="min-w-0">
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <h2 className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Live feed
                </h2>
                {!isTerminalStatus(status) ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-amber-300">
                    <span className="size-1.5 animate-pulse rounded-full bg-current" />
                    streaming
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    ended
                  </span>
                )}
              </div>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
                {items.length === 0 ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    {isTerminalStatus(status)
                      ? "No events were recorded for this run."
                      : "Waiting for the agent…"}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {items.map((item) => (
                      <EventRow key={item.key} item={item} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize="38" minSize="24" className="min-w-0">
            <Tabs defaultValue="plan" className="flex h-full min-h-0 flex-col gap-0">
              <div className="border-b border-border px-3 py-2">
                <TabsList className="w-full">
                  <TabsTrigger value="plan" className="flex-1">
                    Plan
                  </TabsTrigger>
                  <TabsTrigger value="files" className="flex-1">
                    Files
                  </TabsTrigger>
                  <TabsTrigger value="terminal" className="flex-1">
                    Terminal
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent
                value="plan"
                className="min-h-0 flex-1 overflow-y-auto p-4"
              >
                <TodoList todos={todos} />
              </TabsContent>

              <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
                <WorkspaceBrowser
                  path={path}
                  listing={listing}
                  file={file}
                  error={filesError}
                  onRefresh={refresh}
                  onNavigate={setPath}
                  onOpenFile={(target) => void openFile(target)}
                  onBackFromFile={() => setFile(null)}
                />
              </TabsContent>

              <TabsContent
                value="terminal"
                className="min-h-0 flex-1 overflow-hidden"
              >
                <div className="h-full overflow-auto bg-black/35 p-3">
                  {terminalChunks.length === 0 ? (
                    <p className="font-mono text-xs text-muted-foreground">
                      No terminal output yet.
                    </p>
                  ) : (
                    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/85">
                      {terminalChunks}
                    </pre>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
