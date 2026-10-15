import { createOpenAI } from "@ai-sdk/openai";
import type { Sandbox } from "@buildx/sandbox";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  type RunEventInput,
  type RunStatus,
} from "@buildx/shared";
import { stepCountIs, ToolLoopAgent } from "ai";
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
    tools: buildTools(options.sandbox),
    stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
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
 * Run one task to completion, streaming every step as a `RunEventInput`. The
 * caller (orchestrator) owns persistence and assigns event ids.
 */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
  const emit = (event: RunEventInput): Promise<void> =>
    Promise.resolve(options.onEvent(event)).then(() => undefined);
  const ts = (): number => Date.now();

  await emit({ type: "status", data: { status: "running" }, ts: ts() });

  const agent = createAgent(options);
  let status: RunStatus = "completed";

  try {
    const result = await agent.stream({
      prompt: options.task,
      abortSignal: options.abortSignal,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          if (part.text.length > 0) {
            await emit({ type: "text", data: { text: part.text }, ts: ts() });
          }
          break;
        case "tool-call":
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
        case "error":
          status = "failed";
          await emit({
            type: "error",
            data: { message: toText(part.error) },
            ts: ts(),
          });
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

    await emit({
      type: "status",
      data: {
        status,
        message: status === "completed" ? "run completed" : undefined,
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
    };
  } catch (error) {
    status = options.abortSignal?.aborted ? "cancelled" : "failed";
    await emit({ type: "error", data: { message: toText(error) }, ts: ts() });
    await emit({ type: "status", data: { status }, ts: ts() });
    return { status, text: "", steps: 0 };
  }
}
