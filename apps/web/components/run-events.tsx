"use client";

import type { RunEvent, RunStatus, TodoItem } from "@buildx/shared";

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
      /** MCP server that owns this tool, when it came from an MCP server. */
      mcpServer?: string;
      /** Live stdout/stderr streamed while a bash command runs. */
      terminal?: string;
    }
  | { key: number; kind: "file_change"; ts: number; path: string; change: string }
  | { key: number; kind: "todo"; ts: number; todos: TodoItem[] }
  | {
      key: number;
      kind: "context";
      ts: number;
      summary: string;
      estimatedTokens: number;
    }
  | { key: number; kind: "approval"; ts: number; command?: string; status: string }
  | {
      key: number;
      kind: "workspace";
      ts: number;
      status: string;
      step?: string;
      message?: string;
    }
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
      // Bash chunks are attached to their tool row so output appears inline.
      if (event.data.toolCallId) {
        const index = toolIndex.get(event.data.toolCallId);
        const tool = index !== undefined ? items[index] : undefined;
        if (tool?.kind === "tool") {
          tool.terminal = (tool.terminal ?? "") + event.data.chunk;
          continue;
        }
      }
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
          mcpServer: event.data.mcpServer,
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
          existing.mcpServer = event.data.mcpServer ?? existing.mcpServer;
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
            mcpServer: event.data.mcpServer,
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
      case "context":
        items.push({
          key: event.id,
          kind: "context",
          ts: event.ts,
          summary: event.data.summary,
          estimatedTokens: event.data.estimatedTokens,
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
      case "workspace":
        items.push({
          key: event.id,
          kind: "workspace",
          ts: event.ts,
          status: event.data.status,
          step: event.data.step,
          message: event.data.message,
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

export function pretty(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
