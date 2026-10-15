"use client";

import { useState } from "react";
import type { RunEvent, RunStatus, TodoItem } from "@buildx/shared";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  FilePenLine,
  Loader2,
  ShieldAlert,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

export type StreamItem =
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
      kind: "tool";
      ts: number;
      toolCallId: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      pending: boolean;
    }
  | { key: number; kind: "file_change"; ts: number; path: string; change: string }
  | { key: number; kind: "todo"; ts: number; todos: TodoItem[] }
  | { key: number; kind: "approval"; ts: number; command: string; status: string }
  | { key: number; kind: "error"; ts: number; message: string };

/** Collapse adjacent deltas and pair tool_call + tool_result. */
export function toStreamItems(events: RunEvent[]): StreamItem[] {
  const items: StreamItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const event of events) {
    const last = items.at(-1);
    if (event.type === "text") {
      if (last?.kind === "text") {
        last.text += event.data.text;
      } else {
        items.push({
          key: event.id,
          kind: "text",
          ts: event.ts,
          text: event.data.text,
        });
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
      case "tool_call": {
        const index = items.length;
        toolIndex.set(event.data.toolCallId, index);
        items.push({
          key: event.id,
          kind: "tool",
          ts: event.ts,
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          input: event.data.input,
          pending: true,
        });
        break;
      }
      case "tool_result": {
        const index = toolIndex.get(event.data.toolCallId);
        const existing = index !== undefined ? items[index] : undefined;
        if (existing?.kind === "tool") {
          existing.output = event.data.output;
          existing.isError = event.data.isError;
          existing.pending = false;
        } else {
          items.push({
            key: event.id,
            kind: "tool",
            ts: event.ts,
            toolCallId: event.data.toolCallId,
            toolName: event.data.toolName,
            input: undefined,
            output: event.data.output,
            isError: event.data.isError,
            pending: false,
          });
        }
        break;
      }
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
        items.push({
          key: event.id,
          kind: "todo",
          ts: event.ts,
          todos: event.data.todos,
        });
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
        items.push({
          key: event.id,
          kind: "error",
          ts: event.ts,
          message: event.data.message,
        });
        break;
      default:
        break;
    }
  }
  return items;
}

export function latestTodos(events: RunEvent[]): TodoItem[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "todo") return event.data.todos;
  }
  return [];
}

export function pretty(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Clock({ ts }: { ts: number }) {
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
      {formatClock(ts)}
    </span>
  );
}

function ToolCard({ item }: { item: Extract<StreamItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(!item.pending);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-card/40",
          item.isError
            ? "border-red-500/35"
            : item.pending
              ? "border-amber-500/25"
              : "border-border",
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40">
          <Wrench className="size-3.5 shrink-0 text-sky-400" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-sky-300">
            {item.toolName}
          </span>
          {item.pending ? (
            <Loader2 className="size-3.5 animate-spin text-amber-300" />
          ) : item.isError ? (
            <span className="font-mono text-[10px] text-red-300">error</span>
          ) : (
            <CheckCircle2 className="size-3.5 text-emerald-400" />
          )}
          <Clock ts={item.ts} />
          <ChevronDown
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border px-3 py-2">
            {item.input !== undefined ? (
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  input
                </p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {pretty(item.input)}
                </pre>
              </div>
            ) : null}
            {item.output !== undefined ? (
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  output
                </p>
                <pre
                  className={cn(
                    "max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed",
                    item.isError ? "text-red-300" : "text-muted-foreground",
                  )}
                >
                  {pretty(item.output)}
                </pre>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function EventRow({ item }: { item: StreamItem }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="flex gap-3">
          <Clock ts={item.ts} />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
            {item.text}
          </p>
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-3">
          <Clock ts={item.ts} />
          <StatusBadge status={item.status} />
          {item.message ? (
            <span className="truncate text-xs text-muted-foreground">
              {item.message}
            </span>
          ) : null}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "terminal":
      return (
        <div className="flex gap-3">
          <Clock ts={item.ts} />
          <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-black/40">
            <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1">
              <TerminalSquare className="size-3 text-muted-foreground" />
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {item.stream}
              </span>
            </div>
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed",
                item.stream === "stderr" ? "text-red-300" : "text-foreground/80",
              )}
            >
              {item.chunk}
            </pre>
          </div>
        </div>
      );
    case "file_change":
      return (
        <div className="flex items-center gap-3">
          <Clock ts={item.ts} />
          <FilePenLine className="size-3.5 shrink-0 text-emerald-400" />
          <span className="font-mono text-xs text-emerald-400">
            {item.change}{" "}
            <span className="text-foreground/80">{item.path}</span>
          </span>
        </div>
      );
    case "todo":
      return (
        <div className="flex gap-3">
          <Clock ts={item.ts} />
          <TodoList todos={item.todos} />
        </div>
      );
    case "approval":
      return (
        <div className="flex items-center gap-3">
          <Clock ts={item.ts} />
          <ShieldAlert className="size-3.5 shrink-0 text-amber-300" />
          <span className="font-mono text-xs text-muted-foreground">
            approval {item.status}:{" "}
            <span className="text-foreground">{item.command}</span>
          </span>
        </div>
      );
    case "error":
      return (
        <div className="flex gap-3">
          <Clock ts={item.ts} />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
            {item.message}
          </p>
        </div>
      );
    default:
      return null;
  }
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No plan yet — the agent will publish todos as it works.
      </p>
    );
  }
  return (
    <ul className="min-w-0 flex-1 space-y-1.5">
      {todos.map((todo, index) => (
        <li
          key={`${todo.content}-${index}`}
          className={cn(
            "flex items-start gap-2 text-xs",
            todo.status === "done" && "text-muted-foreground line-through",
            todo.status === "in_progress" && "text-amber-300",
            todo.status === "pending" && "text-muted-foreground",
          )}
        >
          {todo.status === "done" ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
          ) : todo.status === "in_progress" ? (
            <CircleDot className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
          ) : (
            <Circle className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}
