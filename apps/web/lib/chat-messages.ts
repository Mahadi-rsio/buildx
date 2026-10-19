import type { RunTaskUsage } from "@buildx/agent";
import type {
  ConversationTurn,
  RunEvent,
  RunStatus,
  TodoItem,
} from "@buildx/shared";
import { toStreamItems, type StreamItem } from "@/components/run-events";
import { buildTokenUsage, type TokenUsage } from "@/lib/tokens";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatBlock {
  id: string;
  kind: "text" | "activity" | "error" | "status" | "todo";
  text?: string;
  item?: StreamItem;
  todos?: TodoItem[];
  streaming?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  blocks: ChatBlock[];
  createdAt: number;
  /** Token accounting for the turn (live estimate, then real usage). */
  usage?: TokenUsage;
  /** Earlier turn replayed from the conversation; not the current run. */
  historical?: boolean;
}

/** Build a chat-shaped view from a run task + append-only events. */
export function buildChatMessages(args: {
  runId: string;
  task: string;
  createdAt: number;
  events: RunEvent[];
  status: RunStatus;
  usage?: RunTaskUsage;
  /** Earlier turns of the conversation, rendered before this run. */
  history?: ConversationTurn[];
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
    if (item.kind === "status" || item.kind === "workspace") {
      // Lifecycle noise belongs in the workspace panel, not the conversation.
      continue;
    }
    if (item.kind === "terminal") {
      // Terminal lives in the workspace panel; skip inline noise.
      continue;
    }
    if (item.kind === "todo") {
      // One live plan card: replace the previous list instead of stacking them.
      const existing = assistantBlocks.find((block) => block.kind === "todo");
      if (existing) {
        existing.todos = item.todos;
      } else {
        assistantBlocks.push({
          id: `todo-${item.key}`,
          kind: "todo",
          todos: item.todos,
        });
      }
      continue;
    }
    if (item.kind === "tool" && item.toolName === "todo_write") {
      // The plan card above is the UI for this tool.
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

  const messages: ChatMessage[] = (args.history ?? [])
    .filter((turn) => turn.content.trim().length > 0)
    .map((turn, index) => ({
      id: `${args.runId}-history-${index}`,
      role: turn.role,
      createdAt: args.createdAt,
      historical: true,
      blocks: [
        {
          id: `${args.runId}-history-${index}-text`,
          kind: "text",
          text: turn.content,
        },
      ],
    }));

  messages.push({
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
  });

  if (assistantBlocks.length > 0 || running) {
    const outputText = assistantBlocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    messages.push({
      id: `${args.runId}-assistant`,
      role: "assistant",
      createdAt: args.events[0]?.ts ?? args.createdAt,
      blocks: assistantBlocks,
      usage: buildTokenUsage({
        task: args.task,
        outputText,
        usage: args.usage,
      }),
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
    .map((item) => {
      if (item.kind === "terminal") return item.chunk;
      if (item.kind === "tool") return item.terminal ?? "";
      return "";
    })
    .join("");
}
