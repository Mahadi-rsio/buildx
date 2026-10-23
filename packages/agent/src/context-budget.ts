import type { ModelMessage, PrepareStepResult, Tool, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

/** Default budget, measured with a conservative characters/4 heuristic. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 75_000;
export const SUMMARIZE_TOOL_NAME = "summarize_context";

/** Truncate the summary to keep the compacted prompt well under budget. */
const MAX_SUMMARY_CHARS = 12_000;
const RECENT_MESSAGES_TO_KEEP = 8;

export interface ContextBudgetOptions {
  /** Token budget. Set to 0 or Infinity to disable compaction. */
  limitTokens?: number;
  /**
   * Produce the summary. Defaults to a deterministic digest of the transcript
   * (no extra model call). Supply an LLM-backed summarizer for higher fidelity.
   */
  summarizer?: (messages: ModelMessage[]) => string | Promise<string>;
  onCompacted?: (info: {
    summary: string;
    messagesBefore: number;
    estimatedTokensBefore: number;
  }) => void | Promise<void>;
}

export interface ContextBudget {
  /** Merge this into the agent tool set. */
  summarizeTool: Tool;
  /** Compose into `prepareStep`; call once per step. */
  prepareStep: (context: {
    messages: ModelMessage[];
    system?: string;
    tools?: ToolSet;
  }) => Promise<PrepareStepResult<ToolSet, never> | undefined>;
  /** Estimated tokens in the latest fully assembled request seen by `prepareStep`. */
  estimatedTokens(): number;
  readonly limitTokens: number;
  /** Number of times the transcript has been compacted so far. */
  readonly compactedCount: number;
}

type AnyRecord = Record<string, unknown>;

function partToText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const value = part as AnyRecord;
  switch (value.type) {
    case "text":
      return typeof value.text === "string" ? value.text : "";
    case "reasoning":
      return typeof value.text === "string" ? value.text : "";
    case "tool-call": {
      const name = typeof value.toolName === "string" ? value.toolName : "tool";
      let input: string;
      try {
        input = JSON.stringify(value.input ?? value.args ?? {});
      } catch {
        input = "";
      }
      return `[called ${name}(${input.slice(0, 400)})]`;
    }
    case "tool-result": {
      const name = typeof value.toolName === "string" ? value.toolName : "tool";
      const output = value.output as AnyRecord | undefined;
      const text =
        output && typeof output === "object" && "value" in output
          ? typeof output.value === "string"
            ? output.value
            : safeStringify(output.value)
          : safeStringify(output);
      return `[${name} result] ${text.slice(0, 800)}`;
    }
    case "file":
      return `[file ${String(value.mediaType ?? value.mimeType ?? "attachment")}]`;
    default:
      return "";
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(partToText).filter(Boolean).join("\n");
  }
  return partToText(content);
}

function messageChars(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += contentToText((message as { content?: unknown }).content).length;
    total += 8;
  }
  return total;
}

/** Rough token estimate (4 characters per token, minimum 1 per message). */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  return Math.ceil(messageChars(messages) / 4);
}

/** Best-effort textual size of a tool's input schema. */
function toolSchemaText(definition: unknown): string {
  const def = definition as { inputSchema?: unknown; parameters?: unknown };
  const schema = def.inputSchema ?? def.parameters;
  if (schema === undefined) return "";
  const candidate = schema as {
    toJSONSchema?: () => unknown;
    shape?: Record<string, unknown>;
  };
  try {
    if (typeof candidate.toJSONSchema === "function") {
      return JSON.stringify(candidate.toJSONSchema());
    }
  } catch {
    // fall through to the shape heuristics below
  }
  if (candidate.shape && typeof candidate.shape === "object") {
    return JSON.stringify(Object.keys(candidate.shape));
  }
  try {
    const serialized = JSON.stringify(schema);
    if (serialized !== "{}" && serialized !== "[]") return serialized;
  } catch {
    // ignore
  }
  return "";
}

/**
 * Approximate the token count of a fully assembled upstream request: system
 * prompt + transcript + tool schemas. This remains a conservative heuristic;
 * provider-reported usage is the source of truth for actual model tokens.
 */
export function estimateRequestTokens(context: {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
}): number {
  const systemChars = context.system?.length ?? 0;
  const messageCharsTotal = messageChars(context.messages);
  let toolChars = 0;
  for (const [name, definition] of Object.entries(context.tools ?? {})) {
    const toolDef = definition as { description?: unknown };
    const description =
      typeof toolDef.description === "string" ? toolDef.description : "";
    toolChars += name.length + description.length + toolSchemaText(definition).length + 16;
  }
  return Math.max(
    1,
    Math.ceil((systemChars + messageCharsTotal + toolChars) / 4),
  );
}

const ROLE_LABEL: Record<string, string> = {
  system: "SYSTEM",
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
};

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Deterministic transcript digest used when no LLM summarizer is supplied. */
export function digestMessages(messages: ModelMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    const text = contentToText(
      (message as { content?: unknown }).content,
    ).trim();
    if (!text) continue;
    const role = ROLE_LABEL[message.role] ?? message.role.toUpperCase();
    const perMessage = message.role === "user" ? 2_000 : 1_200;
    chunks.push(`${role}: ${clip(text, perMessage)}`);
  }
  return clip(chunks.join("\n\n"), MAX_SUMMARY_CHARS);
}

/**
 * Implements the context-window budget. The threshold is evaluated against the
 * assembled request (system + messages + tool definitions), not just messages.
 * Compaction preserves a bounded recent tail verbatim and summarizes the older
 * transcript so active work and the latest tool results are not discarded.
 */
export function createContextBudget(
  options: ContextBudgetOptions = {},
): ContextBudget {
  const limitTokens = options.limitTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  let phase: "idle" | "pending" = "idle";
  let latestMessages: ModelMessage[] = [];
  let latestSystem: string | undefined;
  let latestTools: ToolSet | undefined;
  let summary: string | undefined;
  let snapshotTokens = 0;
  let snapshotCount = 0;
  let compactedCount = 0;
  let latestEstimatedTokens = 0;

  const produceSummary = async (
    messages: ModelMessage[],
  ): Promise<string> => {
    const produced = options.summarizer
      ? await options.summarizer(messages)
      : digestMessages(messages);
    const trimmed = produced.trim();
    return clip(trimmed.length > 0 ? trimmed : "(no summary available)", MAX_SUMMARY_CHARS);
  };

  const summarizeTool = tool({
    description:
      "Compress the conversation so far into a concise summary of the goal, " +
      "decisions, files changed, commands run, and remaining work. Call this " +
      "when the context is getting long; the harness uses the result to compact " +
      "the conversation.",
    inputSchema: z.object({}),
    execute: async () => {
      const produced = await produceSummary(latestMessages);
      summary = produced;
      return { summary: produced };
    },
  });

  const prepareStep = async (context: {
    messages: ModelMessage[];
    system?: string;
    tools?: ToolSet;
  }): Promise<PrepareStepResult<ToolSet, never> | undefined> => {
    latestMessages = context.messages;
    latestSystem = context.system;
    latestTools = context.tools;

    if (!Number.isFinite(limitTokens) || limitTokens <= 0) return undefined;

    if (phase === "pending") {
      if (summary) {
        const recent = latestMessages.slice(-RECENT_MESSAGES_TO_KEEP);
        const compacted: ModelMessage[] = [
          {
            role: "user",
            content:
              "The earlier conversation was compacted to stay within the context " +
              "budget. Here is the summary of everything that happened before the " +
              `recent turns:\n\n${summary}\n\nContinue the task without repeating ` +
              "completed work. The recent turns below are authoritative.",
          },
          ...recent,
        ];
        const info = {
          summary,
          messagesBefore: snapshotCount,
          estimatedTokensBefore: snapshotTokens,
        };
        summary = undefined;
        phase = "idle";
        compactedCount += 1;
        latestMessages = compacted;
        latestEstimatedTokens = estimateRequestTokens({
          system: latestSystem,
          messages: compacted,
          tools: latestTools,
        });
        await options.onCompacted?.(info);
        return { messages: compacted };
      }
      phase = "idle";
      return undefined;
    }

    const tokens = estimateRequestTokens({
      system: context.system,
      messages: context.messages,
      tools: context.tools,
    });
    latestEstimatedTokens = tokens;
    if (tokens > limitTokens) {
      snapshotTokens = tokens;
      snapshotCount = context.messages.length;
      phase = "pending";
      return { toolChoice: { type: "tool", toolName: SUMMARIZE_TOOL_NAME } };
    }
    return undefined;
  };

  return {
    summarizeTool,
    prepareStep,
    estimatedTokens: () => latestEstimatedTokens,
    limitTokens,
    get compactedCount() {
      return compactedCount;
    },
  };
}
