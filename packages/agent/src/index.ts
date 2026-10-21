import { createOpenAI } from "@ai-sdk/openai";
import type { Sandbox } from "@buildx/sandbox";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  getModelContextWindow,
  type AgentCheckpoint,
  type ApprovalOption,
  type ContextUsagePayload,
  type ConversationTurn,
  type FileChangePayload,
  type RunEventInput,
  type RunStatus,
  type TodoItem,
} from "@buildx/shared";
import { stepCountIs, ToolLoopAgent, type ModelMessage, type ToolSet } from "ai";
import {
  createContextBudget,
  estimateRequestTokens,
  SUMMARIZE_TOOL_NAME,
  type ContextBudgetOptions,
} from "./context-budget";
import {
  buildMcpTools,
  connectMcpServer,
  type BuildMcpToolsOptions,
  type McpConnection,
  type McpServerConfig,
} from "./mcp";
import { buildSystemPrompt } from "./prompt";
import {
  buildGitHubTools,
  type GitHubToolsOptions,
} from "./github";
import { buildTools, WaitingForUserError } from "./tools";
import {
  buildSelectedSkillsSection,
  buildSkillsSection,
  createSkillTools,
  type SkillRuntime,
} from "./skills";

export { buildSystemPrompt } from "./prompt";
export { buildTools, WaitingForUserError, type AgentTools } from "./tools";
export {
  buildGitHubTools,
  GitHubPublishError,
  parseGitHubRemote,
  parseRepositoryInput,
  type GitHubToolAuth,
  type GitHubToolsOptions,
} from "./github";
export {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  SUMMARIZE_TOOL_NAME,
  estimateMessageTokens,
  estimateRequestTokens,
} from "./context-budget";
export {
  assertSafeSkillUrl,
  buildSelectedSkillsSection,
  buildSkillsSection,
  computeSkillDigest,
  createSkillRuntime,
  createSkillTools,
  discoverArchiveSkill,
  discoverDirectSkill,
  discoverGitHubSkill,
  discoverSkill,
  parseSkillMarkdown,
  previewSkill,
  parseSkillSource,
  safeSkillPath,
  SkillSecurityError,
  SkillValidationError,
  skillRuntimeFromPackages,
  skillSourceFromPackage,
  validateSkillDescription,
  validateSkillName,
  type DiscoverSkillOptions,
  type LoadedSkill,
  type ParsedSkillSource,
  type SkillCandidate,
  type SkillDiscoveryCache,
  type SkillMetadata,
  type SkillPackage,
  type SelectedSkillsSection,
  type SkillPreview,
  type SkillRuntime,
  type SkillSource,
} from "./skills";
export {
  assertSafeMcpUrl,
  buildMcpTools,
  connectMcpServer,
  listMcpServerTools,
  McpSecurityError,
  type McpServerConfig,
  type McpToolInfo,
} from "./mcp";

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
  /** MCP tools already discovered for this run, merged with workspace tools. */
  mcpTools?: ToolSet;
  /** GitHub publishing credentials; when omitted the GitHub tool is unavailable. */
  github?: GitHubToolsOptions;
  /**
   * Installed skills for this run. Only compact metadata enters the system
   * prompt; full instructions are loaded on demand through `load_skill`.
   */
  skills?: SkillRuntime;
  /**
   * Compact the conversation once it exceeds this token budget. Enabled by
   * default at 75k tokens so long runs never overflow the model window.
   */
  contextBudget?: ContextBudgetOptions;
  /**
   * Explicit model context-window size in tokens, overriding the built-in
   * catalog lookup for `model`. Omit to look the window up from the catalog.
   */
  contextWindowTokens?: number;
  /**
   * Internal wiring: called with the assembled-request token estimate after
   * every `prepareStep`, so the orchestrator can emit live context stats.
   */
  onContextAssembled?: (info: { assembledTokens: number }) => void | Promise<void>;
  /** Called before the first file mutation so the harness can ensure a task branch. */
  onBeforeMutate?: () => void | Promise<void>;
  /**
   * Ask-user gate. Should emit an approval event and either return an answer
   * already known for this resume, or throw `WaitingForUserError`.
   */
  onAskUser?: (request: {
    toolCallId: string;
    question: string;
    options?: ApprovalOption[];
  }) => Promise<{ answer: string }>;
}

function buildToolSet(options: CreateAgentOptions): {
  tools: ToolSet;
  budget?: ReturnType<typeof createContextBudget>;
} {
  const workspaceTools = buildTools(options.sandbox, {
    onTodo: options.onTodo,
    onFileChange: options.onFileChange,
    onTerminal: options.onTerminal,
    onBeforeMutate: options.onBeforeMutate,
    onAskUser: options.onAskUser,
  });
  // Enabled by default at 75k tokens; callers can raise the limit or pass
  // `limitTokens: 0` / `Infinity` to opt out.
  const budget = createContextBudget(options.contextBudget ?? {});
  const tools: ToolSet = {
    ...workspaceTools,
    ...(budget ? { [SUMMARIZE_TOOL_NAME]: budget.summarizeTool } : {}),
    ...(options.mcpTools ?? {}),
    ...(options.github ? buildGitHubTools(options.sandbox, options.github) : {}),
    ...(options.skills ? createSkillTools(options.skills) : {}),
  };
  return { tools, budget };
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
  const { tools, budget } = buildToolSet(options);
  const baseInstructions = options.instructions ?? buildSystemPrompt();
  const skillsSection = options.skills
    ? buildSkillsSection(options.skills.list())
    : "";
  const instructions = skillsSection
    ? `${baseInstructions}\n\n${skillsSection}`
    : baseInstructions;

  return new ToolLoopAgent({
    model: provider.chat(options.model ?? DEFAULT_MODEL),
    instructions,
    tools,
    stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
    // One quota reservation per agent step. Provider-level retries stay
    // disabled here and in LiteLLM (`num_retries: 0`); LiteLLM may still try
    // another upstream via `order`, which is a failover, not a retry loop.
    maxRetries: 0,
    prepareStep: async ({ stepNumber, messages }) => {
      await options.onBeforeModelStep?.({ stepNumber });
      const result = budget ? await budget.prepareStep({ messages }) : undefined;
      await options.onContextAssembled?.({
        assembledTokens: estimateRequestTokens({
          system: instructions,
          messages,
          tools,
        }),
      });
      return result ?? {};
    },
  });
}

export interface RunTaskOptions extends CreateAgentOptions {
  task: string;
  abortSignal?: AbortSignal;
  /** Called for every step the run produces, in order. */
  onEvent: (event: RunEventInput) => void | Promise<void>;
  /** Streaming-HTTP MCP servers to connect for the duration of this run. */
  mcpServers?: McpServerConfig[];
  /** Approval gate for MCP tools the server marks destructive. */
  approveMcpTool?: BuildMcpToolsOptions["approve"];
  /** Skills the user attached; their full instructions are preloaded. */
  selectedSkills?: string[];
  /** Prior checkpoint restored after stop / ask_user pause. */
  checkpoint?: AgentCheckpoint;
  /** Persist the latest valid checkpoint on stop / wait / interrupt. */
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  /** Selected GitHub repository full name for this session, when any. */
  repository?: string;
  /** Local task branch name to create/reuse before edits. */
  taskBranch?: string;
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

  // Some routers reject paid-only catalog models with a 403; point the user at
  // the default route or their provider account instead.
  if (/free tier users do not have access to this model/i.test(haystack)) {
    return "This model is restricted to paid credits on the configured provider. Use the default `auto` model or add credits to your OpenRouter account.";
  }

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
  // Live context-window accounting: refreshed on every prepareStep, surfaced on
  // usage events. `contextLimit` prefers the explicit override, then the model
  // catalog; unknown models omit it so the UI can say "unknown window".
  const contextLimit =
    options.contextWindowTokens ?? getModelContextWindow(options.model) ?? undefined;
  let lastContext: ContextUsagePayload | undefined;
  let compactionCount = 0;

  await emit({ type: "status", data: { status: "running" }, ts: ts() });

  // Attached skills are loaded up front instead of waiting for the model to call
  // `load_skill`. The append-only tool events make the loading visible in the UI.
  let instructions = options.instructions;
  if (options.skills && options.selectedSkills?.length) {
    try {
      const selected = await buildSelectedSkillsSection(
        options.skills,
        options.selectedSkills,
      );
      if (selected.section) {
        instructions = `${instructions ?? buildSystemPrompt()}\n\n${selected.section}`;
      }
      if (selected.missing.length > 0) {
        console.warn(
          `[skills] selected skills unavailable: ${selected.missing.join(", ")}`,
        );
      }
      for (const name of selected.loaded) {
        const toolCallId = `selected-skill:${name}`;
        await emit({
          type: "tool_call",
          data: { toolCallId, toolName: "load_skill", input: { name } },
          ts: ts(),
        });
        await emit({
          type: "tool_result",
          data: {
            toolCallId,
            toolName: "load_skill",
            output: { skill: name, preloaded: true },
          },
          ts: ts(),
        });
      }
    } catch (error) {
      console.warn(`[skills] failed to preload selected skills: ${toText(error)}`);
    }
  }

  // Connect each enabled MCP server. One unreachable server must not abort the
  // run, so failures are logged and the remaining servers still contribute
  // tools. Connections are closed when the run finishes.
  const connections: McpConnection[] = [];
  for (const server of options.mcpServers ?? []) {
    try {
      connections.push(
        await connectMcpServer(server, { signal: options.abortSignal }),
      );
    } catch (error) {
      console.warn(
        `[mcp] could not connect to "${server.name}": ${toText(error)}`,
      );
    }
  }
  const { tools: mcpTools, serverByTool } = buildMcpTools(connections, {
    approve: options.approveMcpTool,
  });
  const mcpServerFor = (toolName: string): string | undefined =>
    serverByTool[toolName]?.config.name;

  let liveTodos: TodoItem[] | undefined = options.checkpoint?.todos;
  let assistantText = "";
  let completedSteps = options.checkpoint?.completedSteps ?? 0;
  let interruptedTool: AgentCheckpoint["interruptedTool"] | undefined =
    options.checkpoint?.interruptedTool;
  let pendingApprovalId = options.checkpoint?.pendingApprovalId;
  let taskBranch = options.taskBranch ?? options.checkpoint?.taskBranch;
  let mutatePrepared = Boolean(taskBranch && options.checkpoint?.taskBranch);

  const saveCheckpoint = async (
    extras: Partial<AgentCheckpoint> = {},
  ): Promise<AgentCheckpoint> => {
    const history: ConversationTurn[] = [
      ...(options.history ?? []),
      { role: "user", content: options.task },
      ...(assistantText.trim().length > 0
        ? [{ role: "assistant" as const, content: assistantText.trim() }]
        : []),
    ];
    const checkpoint: AgentCheckpoint = {
      version: 1,
      history,
      completedSteps,
      ...(liveTodos ? { todos: liveTodos } : {}),
      ...(interruptedTool ? { interruptedTool } : {}),
      ...(taskBranch ? { taskBranch } : {}),
      ...(options.repository ?? options.checkpoint?.repository
        ? {
            repository:
              options.repository ?? options.checkpoint?.repository,
          }
        : {}),
      ...(pendingApprovalId ? { pendingApprovalId } : {}),
      updatedAt: Date.now(),
      ...extras,
    };
    await options.onCheckpoint?.(checkpoint);
    return checkpoint;
  };

  const agent = createAgent({
    ...options,
    instructions,
    mcpTools,
    contextBudget: {
      ...(options.contextBudget ?? {}),
      onCompacted: async (info) => {
        compactionCount += 1;
        await options.contextBudget?.onCompacted?.(info);
        await emit({
          type: "context",
          data: {
            summary: info.summary,
            estimatedTokens: info.estimatedTokensBefore,
          },
          ts: ts(),
        });
      },
    },
    onContextAssembled: async ({ assembledTokens }) => {
      lastContext = {
        assembledTokens,
        estimated: true,
        ...(contextLimit !== undefined
          ? {
              contextLimit,
              utilizationPercent: Math.min(
                100,
                Math.round((assembledTokens / contextLimit) * 100),
              ),
            }
          : {}),
        compactedCount: compactionCount,
      };
    },
    onTodo: async (todos) => {
      liveTodos = todos;
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
    onBeforeMutate: async () => {
      if (mutatePrepared) {
        await options.onBeforeMutate?.();
        return;
      }
      mutatePrepared = true;
      await options.onBeforeMutate?.();
      if (taskBranch) await saveCheckpoint({ taskBranch });
    },
    onAskUser: async (request) => {
      if (options.onAskUser) return options.onAskUser(request);
      await emit({
        type: "approval",
        data: {
          toolCallId: request.toolCallId,
          question: request.question,
          options: request.options,
          status: "pending",
        },
        ts: ts(),
      });
      interruptedTool = {
        toolCallId: request.toolCallId,
        toolName: "ask_user",
        input: {
          question: request.question,
          options: request.options,
        },
      };
      throw new WaitingForUserError(request);
    },
  });
  let status: RunStatus = "completed";
  let failureMessage: string | undefined;

  try {
    // Replay earlier turns (including checkpoint history after stop/ask_user)
    // so a follow-up or resume keeps conversation context.
    const resumeHistory =
      options.checkpoint?.history?.length && !(options.history?.length)
        ? options.checkpoint.history
        : (options.history ?? []);
    const resumeNote =
      options.checkpoint?.interruptedTool &&
      options.checkpoint.interruptedTool.toolName !== "ask_user"
        ? `\n\n[System: A previous attempt was interrupted while calling \`${options.checkpoint.interruptedTool.toolName}\`. Inspect the filesystem/git state before retrying that tool; do not assume its effects are absent or complete.]`
        : "";
    const messages: ModelMessage[] = [
      ...resumeHistory.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: "user" as const, content: `${options.task}${resumeNote}` },
    ];

    const result = await agent.stream({
      messages,
      abortSignal: options.abortSignal,
    });

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
            assistantText += part.text;
            await emit({ type: "text", data: { text: part.text }, ts: ts() });
          }
          break;
        case "tool-call":
          if (options.abortSignal?.aborted) break;
          interruptedTool = {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            maybeApplied: [
              "write_file",
              "edit_file",
              "bash",
              "github_create_pull_request",
            ].includes(part.toolName),
          };
          await emit({
            type: "tool_call",
            data: {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              mcpServer: mcpServerFor(part.toolName),
            },
            ts: ts(),
          });
          break;
        case "tool-result":
          if (options.abortSignal?.aborted) break;
          if (interruptedTool?.toolCallId === part.toolCallId) {
            interruptedTool = undefined;
          }
          await emit({
            type: "tool_result",
            data: {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
              mcpServer: mcpServerFor(part.toolName),
            },
            ts: ts(),
          });
          break;
        case "tool-error":
          if (options.abortSignal?.aborted) break;
          if (part.error instanceof WaitingForUserError) {
            status = "waiting_input";
            interruptedTool = {
              toolCallId: part.error.toolCallId,
              toolName: "ask_user",
              input: {
                question: part.error.question,
                options: part.error.options,
              },
            };
            await emit({
              type: "approval",
              data: {
                toolCallId: part.error.toolCallId,
                question: part.error.question,
                options: part.error.options,
                status: "pending",
              },
              ts: ts(),
            });
            break;
          }
          if (interruptedTool?.toolCallId === part.toolCallId) {
            interruptedTool = undefined;
          }
          await emit({
            type: "tool_result",
            data: {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: toText(part.error),
              isError: true,
              mcpServer: mcpServerFor(part.toolName),
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
            data: {
              steps: completedSteps,
              ...liveUsage,
              ...(lastContext
                ? {
                    context: {
                      ...lastContext,
                      requestInputTokens: part.usage.inputTokens,
                      requestOutputTokens: part.usage.outputTokens,
                    },
                  }
                : {}),
            },
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
      if (status === "waiting_input") break;
    }

    const [text, usage, steps] = await Promise.all([
      result.text,
      result.totalUsage,
      result.steps,
    ]);
    if (!assistantText && text) assistantText = text;

    if (options.abortSignal?.aborted) status = "cancelled";

    if (status === "cancelled" || status === "waiting_input") {
      await saveCheckpoint(
        status === "waiting_input" && pendingApprovalId
          ? { pendingApprovalId }
          : {},
      );
    }

    // Final authoritative usage (the in-flight `finish-step` numbers are
    // per-step and may lag the provider's totals).
    await emit({
      type: "usage",
      data: {
        steps: steps.length,
        inputTokens: usage?.inputTokens ?? liveUsage.inputTokens,
        outputTokens: usage?.outputTokens ?? liveUsage.outputTokens,
        totalTokens: usage?.totalTokens ?? liveUsage.totalTokens,
        ...(lastContext ? { context: lastContext } : {}),
      },
      ts: ts(),
    });

    await emit({
      type: "status",
      data: {
        status,
        message:
          status === "completed"
            ? "run completed"
            : status === "cancelled"
              ? "run cancelled"
              : status === "waiting_input"
                ? "waiting for user input"
                : undefined,
      },
      ts: ts(),
    });

    return {
      status,
      text: assistantText || text,
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
    if (error instanceof WaitingForUserError) {
      interruptedTool = {
        toolCallId: error.toolCallId,
        toolName: "ask_user",
        input: { question: error.question, options: error.options },
      };
      await emit({
        type: "approval",
        data: {
          toolCallId: error.toolCallId,
          question: error.question,
          options: error.options,
          status: "pending",
        },
        ts: ts(),
      });
      await saveCheckpoint();
      await emit({
        type: "status",
        data: { status: "waiting_input", message: "waiting for user input" },
        ts: ts(),
      });
      return { status: "waiting_input", text: assistantText, steps: completedSteps };
    }
    if (options.abortSignal?.aborted) {
      await saveCheckpoint();
      await emit({
        type: "status",
        data: { status: "cancelled", message: "run cancelled" },
        ts: ts(),
      });
      return { status: "cancelled", text: assistantText, steps: completedSteps };
    }
    status = "failed";
    const message =
      failureMessage ?? describeProviderError(error, options.model);
    await emit({ type: "error", data: { message }, ts: ts() });
    await emit({ type: "status", data: { status }, ts: ts() });
    return { status, text: assistantText, steps: completedSteps, error: message };
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }
}
