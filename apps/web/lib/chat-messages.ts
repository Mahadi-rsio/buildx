import type { RunEvent, RunStatus } from "@buildx/shared";
import { toStreamItems, type StreamItem } from "@/components/run-events";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatBlock {
  id: string;
  kind: "text" | "activity" | "error" | "status";
  text?: string;
  item?: StreamItem;
  streaming?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  blocks: ChatBlock[];
  createdAt: number;
}

/** Build a chat-shaped view from a run task + append-only events. */
export function buildChatMessages(args: {
  runId: string;
  task: string;
  createdAt: number;
  events: RunEvent[];
  status: RunStatus;
}): ChatMessage[] {
  const items = toStreamItems(args.events);
  const assistantBlocks: ChatBlock[] = [];

  for (const item of items) {
    if (item.kind === "text") {
      assistantBlocks.push({
        id: `text-${item.key}`,
        kind: "text",
        text: item.text,
        streaming: false,
      });
      continue;
    }
    if (item.kind === "error") {
      assistantBlocks.push({
        id: `error-${item.key}`,
        kind: "error",
        text: item.message,
        item,
      });
      continue;
    }
    if (item.kind === "status") {
      // Surface terminal/failed status in-thread; skip noisy queued/running.
      if (
        item.status === "completed" ||
        item.status === "failed" ||
        item.status === "cancelled"
      ) {
        assistantBlocks.push({
          id: `status-${item.key}`,
          kind: "status",
          text: item.message,
          item,
        });
      }
      continue;
    }
    if (item.kind === "terminal") {
      // Terminal lives in the workspace panel; skip inline noise.
      continue;
    }
    assistantBlocks.push({
      id: `activity-${item.key}`,
      kind: "activity",
      item,
    });
  }

  const running =
    args.status === "running" ||
    args.status === "queued" ||
    args.status === "waiting_input";

  if (running) {
    const lastText = [...assistantBlocks].reverse().find((b) => b.kind === "text");
    if (lastText) lastText.streaming = true;
  }

  const messages: ChatMessage[] = [
    {
      id: `${args.runId}-user`,
      role: "user",
      createdAt: args.createdAt,
      blocks: [
        {
          id: `${args.runId}-user-text`,
          kind: "text",
          text: args.task,
        },
      ],
    },
  ];

  if (assistantBlocks.length > 0 || running) {
    messages.push({
      id: `${args.runId}-assistant`,
      role: "assistant",
      createdAt: args.events[0]?.ts ?? args.createdAt,
      blocks: assistantBlocks,
    });
  }

  return messages;
}

export function collectFileChanges(
  events: RunEvent[],
): Array<{ path: string; change: string; ts: number }> {
  const map = new Map<string, { path: string; change: string; ts: number }>();
  for (const event of events) {
    if (event.type !== "file_change") continue;
    map.set(event.data.path, {
      path: event.data.path,
      change: event.data.change,
      ts: event.ts,
    });
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function collectTerminalOutput(events: RunEvent[]): string {
  return toStreamItems(events)
    .filter(
      (item): item is Extract<StreamItem, { kind: "terminal" }> =>
        item.kind === "terminal",
    )
    .map((item) => item.chunk)
    .join("");
}

export function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    go: "go",
    rs: "rust",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? "text";
}
