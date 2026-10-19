import { createOpenAI } from "@ai-sdk/openai";
import type { Sandbox } from "@buildx/sandbox";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  type ConversationTurn,
  type FileChangePayload,
  type RunEventInput,
  type RunStatus,
  type TodoItem,
} from "@buildx/shared";
import { stepCountIs, ToolLoopAgent, type ModelMessage } from "ai";
import { buildSystemPrompt } from "./prompt";
import { buildTools } from "./tools";

export { buildSystemPrompt } from "./prompt";
export { buildTools, type AgentTools } from "./tools";

export interface CreateAgentOptions {
  /** Model id passed to the OpenAI-compatible provider. */
  model?: string;
  sandbox: Sandbox;
  /** Maximum agent loop steps before stopping. Defaults to 40. */
  maxSteps?: number;
  apiKey?: string;
  baseURL?: string;
  instructions?: string;
  /** Prior conversation turns, replayed before the new task. */
  history?: ConversationTurn[];
  /** Called whenever the agent replaces its visible task list. */
  onTodo?: (todos: TodoItem[]) => void | Promise<void>;
  /** Called after a file is written or edited. */
  onFileChange?: (change: FileChangePayload) => void | Promise<void>;
  /** Called for every chunk a bash command streams. */
  onTerminal?: (chunk: {
    stream: "stdout" | "stderr";
    chunk: string;
    toolCallId?: string;
  }) => void | Promise<void>;
  /**
   * Called once before every upstream model request, including tool-loop
   * iterations. Throwing aborts the run before the request leaves the app, so
   * this is the quota reservation boundary.
   */
  onBeforeModelStep?: (step: { stepNumber: number }) => void | Promise<void>;
}

/**
 * Build a `ToolLoopAgent` wired to the workspace tools. Note: the public stop
 * condition is `stepCountIs` in the installed `ai` build (arcetecture.md §3.4
 * documents `stepCountIs`), and `stream()` is async — it must be awaited.
 */
export function createAgent(options: CreateAgentOptions) {
  const provider = createOpenAI({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
  });

  return new ToolLoopAgent({
    model: provider.chat(options.model ?? DEFAULT_MODEL),
    instructions: options.instructions ?? buildSystemPrompt(),
    tools: buildTools(options.sandbox, {
      onTodo: options.onTodo,
      onFileChange: options.onFileChange,
      onTerminal: options.onTerminal,
    }),
    stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
    // One quota reservation per agent step. Provider-level retries stay
    // disabled here and in LiteLLM (`num_retries: 0`); LiteLLM may still try
    // another upstream via `order`, which is a failover, not a retry loop.
    maxRetries: 0,
    prepareStep: async ({ stepNumber }) => {
      await options.onBeforeModelStep?.({ stepNumber });
      return {};
    },
  });
}

export interface RunTaskOptions extends CreateAgentOptions {
  task: string;
  abortSignal?: AbortSignal;
  /** Called for every step the run produces, in order. */
  onEvent: (event: RunEventInput) => void | Promise<void>;
}

export interface RunTaskUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

export interface RunTaskResult {
  status: RunStatus;
  text: string;
  steps: number;
  usage?: RunTaskUsage;
  /** Human-readable failure reason when `status` is `failed`. */
  error?: string;
}

function toText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Turn provider errors into actionable messages. Some routers (`auto` combos)
 * swap the upstream model per request, and a model with its own built-in tools
 * can emit a tool name the caller never declared.
 */
function describeProviderError(error: unknown, model: string | undefined): string {
  const message = toText(error);
  const responseBody = (error as { responseBody?: unknown } | null)?.responseBody;
  const body =
    typeof responseBody === "string"
      ? responseBody
      : responseBody === undefined
        ? ""
        : toText(responseBody);
  const haystack = `${message}\n${body}`;
  const isAuto = !model || model === "auto" || model.startsWith("auto/");
  const guidance = isAuto
    ? "The router picked an upstream with unreliable tool calling. Retry the run or pick a concrete model in Settings."
    : "The model invented a tool Buildx does not provide. Pick a model with reliable tool calling in Settings.";

  // LiteLLM currently wraps Groq's `tool_use_failed` error in a Python
  // ValueError, so the original message may not include the tool name.
  if (/tool_use_failed/i.test(haystack)) {
    return `The upstream model tried to call a tool Buildx does not provide. ${guidance}`;
  }

  const invalidTool = haystack.match(/attempted to call tool '([^']+)'/i)?.[1];
  if (!invalidTool) return message;
  return `The model tried to call unknown tool "${invalidTool}". Buildx only provides its workspace tools. ${guidance}`;
}

/**
 * Run one task to completion, streaming every step as a `RunEventInput`. The
 * caller (orchestrator) owns persistence and assigns event ids.
 */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
  const emit = (event: RunEventInput): Promise<void> =>
    Promise.resolve(options.onEvent(event)).then(() => undefined);
  const ts = (): number => Date.now();

  await emit({ type: "status", data: { status: "running" }, ts: ts() });

  const agent = createAgent({
    ...options,
    onTodo: async (todos) => {
      await options.onTodo?.(todos);
      await emit({ type: "todo", data: { todos }, ts: ts() });
    },
    onFileChange: async (change) => {
      await options.onFileChange?.(change);
      await emit({ type: "file_change", data: change, ts: ts() });
    },
    onTerminal: async (chunk) => {
      await options.onTerminal?.(chunk);
      await emit({ type: "terminal", data: chunk, ts: ts() });
    },
  });
  let status: RunStatus = "completed";
  let failureMessage: string | undefined;

  try {
    // Replay earlier turns so a follow-up message keeps the conversation
    // context instead of starting from scratch.
    const messages: ModelMessage[] = [
      ...(options.history ?? []).map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: "user" as const, content: options.task },
    ];

    const result = await agent.stream({
      messages,
      abortSignal: options.abortSignal,
    });

    let completedSteps = 0;
    let liveUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for await (const part of result.fullStream) {
      if (options.abortSignal?.aborted) {
        status = "cancelled";
        break;
      }
      switch (part.type) {
        case "text-delta":
          if (options.abortSignal?.aborted) break;
          if (part.text.length > 0) {
            await emit({ type: "text", data: { text: part.text }, ts: ts() });
          }
          break;
        case "tool-call":
          if (options.abortSignal?.aborted) break;
          await emit({
            type: "tool_call",
            data: {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            },
            ts: ts(),
          });
          break;
        case "tool-result":
          if (options.abortSignal?.aborted) break;
          await emit({
            type: "tool_result",
            data: {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            },
            ts: ts(),
          });
          break;
        case "tool-error":
          if (options.abortSignal?.aborted) break;
          await emit({
            type: "tool_result",
            data: {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: toText(part.error),
              isError: true,
            },
            ts: ts(),
          });
          break;
        case "finish-step": {
          completedSteps += 1;
          liveUsage = {
            inputTokens: liveUsage.inputTokens + (part.usage.inputTokens ?? 0),
            outputTokens:
              liveUsage.outputTokens + (part.usage.outputTokens ?? 0),
            totalTokens:
              liveUsage.totalTokens + (part.usage.totalTokens ?? 0),
          };
          await emit({
            type: "usage",
            data: { steps: completedSteps, ...liveUsage },
            ts: ts(),
          });
          break;
        }
        case "error":
          if (!options.abortSignal?.aborted) {
            status = "failed";
            failureMessage = describeProviderError(part.error, options.model);
            await emit({
              type: "error",
              data: { message: failureMessage },
              ts: ts(),
            });
          }
          break;
        case "abort":
          status = "cancelled";
          break;
        default:
          break;
      }
    }

    const [text, usage, steps] = await Promise.all([
      result.text,
      result.totalUsage,
      result.steps,
    ]);

    if (options.abortSignal?.aborted) status = "cancelled";

    // Final authoritative usage (the in-flight `finish-step` numbers are
    // per-step and may lag the provider's totals).
    await emit({
      type: "usage",
      data: {
        steps: steps.length,
        inputTokens: usage?.inputTokens ?? liveUsage.inputTokens,
        outputTokens: usage?.outputTokens ?? liveUsage.outputTokens,
        totalTokens: usage?.totalTokens ?? liveUsage.totalTokens,
      },
      ts: ts(),
    });

    await emit({
      type: "status",
      data: {
        status,
        message: status === "completed" ? "run completed" : status === "cancelled" ? "run cancelled" : undefined,
      },
      ts: ts(),
    });

    return {
      status,
      text,
      steps: steps.length,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
      error: failureMessage,
    };
  } catch (error) {
    if (options.abortSignal?.aborted) {
      await emit({
        type: "status",
        data: { status: "cancelled", message: "run cancelled" },
        ts: ts(),
      });
      return { status: "cancelled", text: "", steps: 0 };
    }
    status = "failed";
    const message =
      failureMessage ?? describeProviderError(error, options.model);
    await emit({ type: "error", data: { message }, ts: ts() });
    await emit({ type: "status", data: { status }, ts: ts() });
    return { status, text: "", steps: 0, error: message };
  }
}
