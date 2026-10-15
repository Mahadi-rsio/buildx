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
import type {
  EventType,
  RunEvent,
  RunStatus,
  TodoItem,
} from "@buildx/shared";
import { isTerminalStatus } from "@buildx/shared";
import { StatusBadge } from "@/components/status-badge";
import { formatAgo, formatClock } from "@/lib/format";
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

/**
 * The SSE frame wraps `event.data` as `{ ts, data }` so the client keeps the
 * server timestamp without polluting the payload contract in `@buildx/shared`.
 */
interface Frame {
  ts: number;
  data: unknown;
}

type Item =
  | { key: number; kind: "text"; ts: number; text: string }
  | {
      key: number;
      kind: "terminal";
      ts: number;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | { key: number; kind: "status"; ts: number; status: RunStatus; message?: string }
  | {
      key: number;
      kind: "tool_call";
      ts: number;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      key: number;
      kind: "tool_result";
      ts: number;
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    }
  | { key: number; kind: "file_change"; ts: number; path: string; change: string }
  | { key: number; kind: "todo"; ts: number; todos: TodoItem[] }
  | { key: number; kind: "approval"; ts: number; command: string; status: string }
  | { key: number; kind: "error"; ts: number; message: string };

/** Collapse adjacent deltas so streaming text renders as one block. */
function toItems(events: RunEvent[]): Item[] {
  const items: Item[] = [];
  for (const event of events) {
    const last = items.at(-1);
    if (event.type === "text") {
      if (last?.kind === "text") {
        last.text += event.data.text;
      } else {
        items.push({ key: event.id, kind: "text", ts: event.ts, text: event.data.text });
      }
      continue;
    }
    if (event.type === "terminal") {
      if (last?.kind === "terminal" && last.stream === event.data.stream) {
        last.chunk += event.data.chunk;
      } else {
        items.push({
          key: event.id,
          kind: "terminal",
          ts: event.ts,
          stream: event.data.stream,
          chunk: event.data.chunk,
        });
      }
      continue;
    }
    switch (event.type) {
      case "status":
        items.push({
          key: event.id,
          kind: "status",
          ts: event.ts,
          status: event.data.status,
          message: event.data.message,
        });
        break;
      case "tool_call":
        items.push({
          key: event.id,
          kind: "tool_call",
          ts: event.ts,
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          input: event.data.input,
        });
        break;
      case "tool_result":
        items.push({
          key: event.id,
          kind: "tool_result",
          ts: event.ts,
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          output: event.data.output,
          isError: event.data.isError,
        });
        break;
      case "file_change":
        items.push({
          key: event.id,
          kind: "file_change",
          ts: event.ts,
          path: event.data.path,
          change: event.data.change,
        });
        break;
      case "todo":
        items.push({ key: event.id, kind: "todo", ts: event.ts, todos: event.data.todos });
        break;
      case "approval":
        items.push({
          key: event.id,
          kind: "approval",
          ts: event.ts,
          command: event.data.command,
          status: event.data.status,
        });
        break;
      case "error":
        items.push({ key: event.id, kind: "error", ts: event.ts, message: event.data.message });
        break;
      default:
        break;
    }
  }
  return items;
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function EventRow({ item }: { item: Item }) {
  const clock = (
    <span className="font-mono text-[10px] text-neutral-600">
      {formatClock(item.ts)}
    </span>
  );

  switch (item.kind) {
    case "text":
      return (
        <div className="flex gap-3">
          <span className="w-16 shrink-0 pt-0.5">{clock}</span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-neutral-200">
            {item.text}
          </p>
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0">{clock}</span>
          <StatusBadge status={item.status} />
          {item.message ? (
            <span className="truncate text-xs text-neutral-500">{item.message}</span>
          ) : null}
        </div>
      );
    case "tool_call":
      return (
        <div className="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-mono text-xs font-medium text-sky-300">
              → {item.toolName}
            </span>
            {clock}
          </div>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-400">
            {pretty(item.input)}
          </pre>
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`rounded-md border px-3 py-2 ${
            item.isError
              ? "border-red-500/40 bg-red-500/10"
              : "border-neutral-800 bg-neutral-950"
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <span
              className={`truncate font-mono text-xs font-medium ${
                item.isError ? "text-red-300" : "text-emerald-300"
              }`}
            >
              ← {item.toolName}
              {item.isError ? " (error)" : ""}
            </span>
            {clock}
          </div>
          <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-400">
            {pretty(item.output)}
          </pre>
        </div>
      );
    case "terminal":
      return (
        <div className="flex gap-3">
          <span className="w-16 shrink-0 pt-0.5">{clock}</span>
          <pre
            className={`min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-black/60 px-3 py-2 font-mono text-[11px] leading-relaxed ${
              item.stream === "stderr" ? "text-red-300" : "text-neutral-300"
            }`}
          >
            {item.chunk}
          </pre>
        </div>
      );
    case "file_change":
      return (
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0">{clock}</span>
          <span className="font-mono text-xs text-emerald-400">
            {item.change} <span className="text-neutral-300">{item.path}</span>
          </span>
        </div>
      );
    case "todo":
      return (
        <div className="flex gap-3">
          <span className="w-16 shrink-0">{clock}</span>
          <ul className="min-w-0 flex-1 space-y-0.5">
            {item.todos.map((todo, index) => (
              <li
                key={`${item.key}-${index}`}
                className={`font-mono text-xs ${
                  todo.status === "done"
                    ? "text-neutral-600 line-through"
                    : todo.status === "in_progress"
                      ? "text-amber-300"
                      : "text-neutral-400"
                }`}
              >
                {todo.status === "pending" ? "☐ " : todo.status === "in_progress" ? "▣ " : "☑ "}
                {todo.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "approval":
      return (
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0">{clock}</span>
          <span className="font-mono text-xs text-neutral-400">
            approval {item.status}: <span className="text-neutral-200">{item.command}</span>
          </span>
        </div>
      );
    case "error":
      return (
        <div className="flex gap-3">
          <span className="w-16 shrink-0 pt-0.5">{clock}</span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
            {item.message}
          </p>
        </div>
      );
    default:
      return null;
  }
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

  const items = useMemo(() => toItems(events), [events]);
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

  // Initial fetch + SSE subscription for the run itself.
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
            const payload = frame.data as { status: RunStatus; message?: string };
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
        return () => source?.removeEventListener(type, handler as EventListener);
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

  // Load the workspace listing whenever the directory, run, or status changes,
  // so the panel reflects files written during the run.
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

  // Stick to the bottom unless the user has scrolled up to read history.
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

  const upPath = (() => {
    if (path === "." || path === "/") return null;
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? parts.join("/") : ".";
  })();

  if (notFound) {
    return (
      <div className="rounded-lg border border-neutral-900 p-8 text-center">
        <p className="text-sm text-neutral-400">
          Run <code className="font-mono">{runId}</code> no longer exists.
        </p>
        <Link href="/" className="mt-3 inline-block text-sm text-sky-400 hover:underline">
          ← back to runs
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/"
            className="font-mono text-xs text-neutral-500 hover:text-neutral-300"
          >
            ← all runs
          </Link>
          <h1 className="mt-2 max-w-3xl break-words text-lg font-semibold text-neutral-100">
            {run?.task ?? "Loading run…"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
            <StatusBadge status={status} />
            <span className="font-mono">{runId}</span>
            {run ? <span>{run.model}</span> : null}
            {run ? <span>{run.stats?.usage?.totalTokens ?? 0} tokens</span> : null}
            {run ? <span>{formatAgo(run.createdAt)}</span> : null}
          </div>
        </div>
        {!isTerminalStatus(status) ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-300 transition hover:bg-red-500/10"
          >
            Stop run
          </button>
        ) : null}
      </div>

      {run?.error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {run.error}
        </div>
      ) : null}
      {streamError ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          {streamError}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="min-w-0 lg:col-span-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Event stream
            </h2>
            <span className="text-[11px] text-neutral-600">
              {events.length} events
            </span>
          </div>
          <div
            ref={scrollRef}
            className="h-[65vh] overflow-y-auto rounded-lg border border-neutral-900 bg-neutral-950 p-4"
          >
            {items.length === 0 ? (
              <p className="font-mono text-xs text-neutral-600">
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
        </section>

        <aside className="min-w-0 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Workspace
            </h2>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              refresh
            </button>
          </div>

          <div className="rounded-lg border border-neutral-900 bg-neutral-950">
            <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-2 font-mono text-[11px] text-neutral-500">
              {upPath !== null && !file ? (
                <button
                  type="button"
                  onClick={() => setPath(upPath)}
                  className="text-neutral-400 hover:text-neutral-200"
                >
                  ↑
                </button>
              ) : file ? (
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="text-neutral-400 hover:text-neutral-200"
                >
                  ←
                </button>
              ) : null}
              <span className="truncate">{file ? file.path : path}</span>
            </div>

            {filesError ? (
              <p className="px-3 py-3 text-xs text-red-400">{filesError}</p>
            ) : file ? (
              <div className="max-h-[58vh] overflow-auto p-3">
                <div className="mb-2 font-mono text-[11px] text-neutral-500">
                  {file.size} bytes
                  {file.binary ? " · binary file (not shown)" : ""}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-300">
                  {file.binary ? "" : file.content}
                </pre>
              </div>
            ) : listing ? (
              listing.entries.length === 0 ? (
                <p className="px-3 py-3 text-xs text-neutral-600">
                  Empty — the agent has not written anything here yet.
                </p>
              ) : (
                <ul className="max-h-[58vh] overflow-auto py-1">
                  {listing.entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() =>
                          entry.type === "dir"
                            ? setPath(entry.path)
                            : void openFile(entry.path)
                        }
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-neutral-300 transition hover:bg-neutral-900"
                      >
                        <span
                          className={
                            entry.type === "dir" ? "text-amber-400" : "text-neutral-600"
                          }
                        >
                          {entry.type === "dir" ? "▸" : "·"}
                        </span>
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p className="px-3 py-3 text-xs text-neutral-600">Loading…</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
