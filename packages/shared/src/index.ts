import { z } from "zod";

/** Model → context-window metadata used to render live context stats. */
export { getModelContextWindow } from "./model-context";

/** MCP Marketplace catalog types + pure search/filter helpers. */
export {
  MCP_CATALOG_CATEGORIES,
  MCP_CATALOG_CATEGORY_LABELS,
  findCatalogEntry,
  isConnectable,
  searchCatalog,
  type McpAuthMode,
  type McpCatalogCategory,
  type McpCatalogEntry,
  type McpCatalogQuery,
  type McpOAuthConfig,
} from "./mcp-catalog";

/** Default model id when `AGENT_MODEL` is unset. */
export const DEFAULT_MODEL = "auto";

/** Upstream model aliases exposed by the LiteLLM proxy. */
export const LITELLM_MODEL_ALIASES = ["auto"] as const;
export type LitellmModelAlias = (typeof LITELLM_MODEL_ALIASES)[number];

export function isLitellmAlias(model: string | undefined): boolean {
  return (LITELLM_MODEL_ALIASES as readonly string[]).includes(
    (model ?? "").trim(),
  );
}
/** Default agent loop cap when `AGENT_MAX_STEPS` is unset (see `.env.example`). */
export const DEFAULT_MAX_STEPS = 40;

/** Context-window sizes the dashboard lets the user pick from. */
export const CONTEXT_WINDOW_OPTIONS = [
  100_000,
  200_000,
  500_000,
  1_000_000,
] as const;
export type ContextWindowTokens = (typeof CONTEXT_WINDOW_OPTIONS)[number];

/** Default context window / compaction ceiling for a run. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS: ContextWindowTokens = 100_000;

export function isContextWindowTokens(
  value: unknown,
): value is ContextWindowTokens {
  return (
    typeof value === "number" &&
    (CONTEXT_WINDOW_OPTIONS as readonly number[]).includes(value)
  );
}

/**
 * Lifecycle status of a run. Mirrors the `runs.status` column in
 * arcetecture.md §4.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/** Statuses in which no further events will arrive — streams may be closed. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export interface StatusPayload {
  status: RunStatus;
  message?: string;
}

export interface TextPayload {
  text: string;
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Set when the tool came from an MCP server. */
  mcpServer?: string;
}

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
  /** Set when the tool came from an MCP server. */
  mcpServer?: string;
}

/** Emitted when the harness compacts the conversation to fit the token budget. */
export interface ContextPayload {
  summary: string;
  /** Estimated tokens in the transcript that was replaced. */
  estimatedTokens: number;
}

export interface TerminalPayload {
  stream: "stdout" | "stderr";
  chunk: string;
  /** The bash tool call that produced this chunk, when known. */
  toolCallId?: string;
}

export interface FileChangePayload {
  path: string;
  change: "create" | "write" | "edit";
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
}

export interface TodoPayload {
  todos: TodoItem[];
}

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface ApprovalPayload {
  toolCallId: string;
  /** Shell/command approval (legacy) or short label for the request. */
  command?: string;
  /** Structured ask_user question shown in chat. */
  question?: string;
  /** Optional multiple-choice answers for ask_user. */
  options?: ApprovalOption[];
  /** User's chosen option id or free-text answer. */
  answer?: string;
  status: "pending" | "approved" | "denied" | "answered";
}

/** Durable agent checkpoint persisted on stop / ask_user pause. */
export interface AgentCheckpoint {
  version: 1;
  /** Conversation turns to replay on resume (includes tool summaries). */
  history: ConversationTurn[];
  /** Completed agent steps before the interruption. */
  completedSteps: number;
  /** In-progress todo list when interrupted. */
  todos?: TodoItem[];
  /** Tool call that was running or awaiting the user, if any. */
  interruptedTool?: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    /** True when effects may already have landed on disk/git. */
    maybeApplied?: boolean;
  };
  /** Last relevant tool results so a resumed run can avoid repeating work. */
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    output: string;
  }>;
  /** Latest structured ask_user answer, replayed when the same run resumes. */
  approvalAnswer?: {
    toolCallId: string;
    question: string;
    answer: string;
  };
  /** Local task branch created for this run, when the workspace is a git repo. */
  taskBranch?: string;
  /** Selected GitHub repository full name, when the session targeted one. */
  repository?: string;
  /** Pending ask_user approval id, when paused for input. */
  pendingApprovalId?: string;
  updatedAt: number;
}

export interface ErrorPayload {
  message: string;
  toolName?: string;
}

/** One prior turn supplied to the agent so follow-ups keep the conversation. */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Per-request context-window accounting emitted on each `usage` event. The
 * estimate is a chars/4 approximation of the assembled request (system prompt +
 * transcript + tool schemas), tagged `estimated: true` so the UI never passes
 * it off as provider-measured token counts.
 */
export interface ContextUsagePayload {
  /** Provider-reported input tokens for this single step's request. */
  requestInputTokens?: number;
  /** Provider-reported output tokens for this single step's request. */
  requestOutputTokens?: number;
  /** Estimated tokens in the assembled request that was sent. */
  assembledTokens?: number;
  /** True when `assembledTokens` is an approximation, not provider usage. */
  estimated: boolean;
  /** Model context-window limit in tokens, when known for this model. */
  contextLimit?: number;
  /** `assembledTokens` / `contextLimit` as a 0–100 number, when both known. */
  utilizationPercent?: number;
  /** Number of times the transcript has been compacted so far in this run. */
  compactedCount?: number;
}

/** Live step/token accounting emitted while the agent loop is still running. */
export interface UsagePayload {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Context-window stats for the most recent request (optional, live). */
  context?: ContextUsagePayload;
  /** UI indicator showing the current execution phase. */
  uiIndicator?: UiIndicator;
}

export type WorkspaceEventStatus =
  | "workspace.restoring"
  | "workspace.ready"
  | "workspace.archiving"
  | "workspace.archived";

/** UI indicator showing the current execution phase. */
export type UiIndicator =
  | "preparing_workspace"
  | "analyzing_codebase"
  | "searching_code"
  | "thinking"
  | "running_tool"
  | "updating_code_index"
  | "verifying_changes"
  | "saving_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "graphify_ready"
  | "graphify_searching"
  | "graphify_indexing"
  | "code_search_rg_fallback";

export interface WorkspacePayload {
  status: WorkspaceEventStatus;
  step?: string;
  message?: string;
  workspaceId?: string;
  idleDeadlineAt?: number;
  usage?: {
    cpuHoursUsed: number;
    cpuHoursLimit: number;
    dailyRequestsUsed: number;
    dailyRequestsLimit: number;
    nextDhakaResetAt: number;
  };
}

/**
 * Payload shape for every append-only event type. The event `type` is the key,
 * so the set of valid event names is the keyof this map (arcetecture.md §4).
 */
export interface RunEventMap {
  status: StatusPayload;
  text: TextPayload;
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  terminal: TerminalPayload;
  file_change: FileChangePayload;
  todo: TodoPayload;
  approval: ApprovalPayload;
  error: ErrorPayload;
  workspace: WorkspacePayload;
  usage: UsagePayload;
  context: ContextPayload;
}

export type EventType = keyof RunEventMap;

/**
 * An append-only event row. `id` is assigned by the event store (monotonic per
 * store) and `runId` links it to a run. The `type`/`data` pair is a
 * discriminated union, so narrowing on `type` narrows `data`.
 */
export type RunEvent<T extends EventType = EventType> = {
  id: number;
  runId: string;
  ts: number;
} & { [K in T]: { type: K; data: RunEventMap[K] } }[T];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An event as produced by the agent loop, before the store assigns id/runId. */
export type RunEventInput = DistributiveOmit<RunEvent, "id" | "runId">;

export const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(100_000),
});

export const createRunSchema = z.object({
  task: z.string().min(1, "task is required"),
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().max(1000).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  /** Durable conversation this run belongs to (client-generated). */
  conversationId: z.string().uuid().optional(),
  /** Prior conversation turns; the agent replays them before the new task. */
  history: z.array(conversationTurnSchema).max(100).optional(),
  /** Installed skills to preload into this run's model context. */
  skillNames: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          "invalid skill name",
        ),
    )
    .max(20)
    .optional(),
  /** Requested context window for compaction and live utilization stats. */
  contextWindow: z
    .number()
    .int()
    .refine(isContextWindowTokens, "unsupported context window")
    .optional(),
  /** GitHub `owner/repo` selected on the dashboard for this session. */
  repository: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, "invalid repository")
    .max(200)
    .optional(),
  /** Continue from an interrupted run's persisted checkpoint. */
  resumeFromRunId: z.string().uuid().optional(),
  /** Workspace selected for this run. */
  workspaceId: z.string().uuid().optional(),
  /** Client-generated id for optimistic message reconciliation. */
  clientMessageId: z.string().min(1).max(128).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunSchema>;

export const conversationEventSchema = z.object({
  id: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(100_000),
  kind: z.enum(["message"]).default("message"),
  createdAt: z.number().int().positive(),
  /** Run that produced this message, when known. */
  runId: z.string().uuid().optional(),
});

export const conversationSyncSchema = z.object({
  conversationId: z.string().uuid(),
  events: z.array(conversationEventSchema).min(1).max(200),
});
export type ConversationSyncRequest = z.infer<typeof conversationSyncSchema>;

export const envSchema = z.object({
  AGENT_MODEL: z.string().min(1).default(DEFAULT_MODEL),
  AGENT_MAX_STEPS: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(DEFAULT_MAX_STEPS),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.string().min(1).optional(),
  LITELLM_API_KEY: z.string().min(1).optional(),
  LITELLM_BASE_URL: z.string().min(1).optional(),
});
export type Env = z.infer<typeof envSchema>;

/**
 * The model provider a run routes through: the LiteLLM proxy for `auto`, or
 * OpenRouter for concrete `provider/model` ids.
 */
export type ModelProviderId = "litellm" | "openrouter";

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = [
  "litellm",
  "openrouter",
];

export const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000/v1";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ModelProvider {
  id: ModelProviderId;
  label: string;
  baseURL: string | undefined;
  hasApiKey: boolean;
  /** The primary provider owns the default model (`AGENT_MODEL`). */
  primary: boolean;
}

/**
 * Parse and validate agent configuration from the environment. Empty strings
 * (e.g. blank lines in `.env`) are treated as unset so defaults apply.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    cleaned[key] = value === "" ? undefined : value;
  }
  return envSchema.parse(cleaned);
}

export interface EnvStatus {
  hasApiKey: boolean;
  model: string;
  maxSteps: number;
  baseURL: string | undefined;
  /** Configured model providers, LiteLLM first when configured. */
  providers: ModelProvider[];
}

/**
 * Non-throwing configuration probe for dashboards/config endpoints. Unlike
 * {@link loadEnv} this never throws — it reports whether the key is present and
 * the effective defaults so the UI can explain why a run cannot start.
 */
export function envStatus(
  source: Record<string, string | undefined> = process.env,
): EnvStatus {
  const model = (source.AGENT_MODEL ?? "").trim() || DEFAULT_MODEL;
  const stepsRaw = (source.AGENT_MAX_STEPS ?? "").trim();
  const parsed = Number(stepsRaw);
  const maxSteps =
    stepsRaw && Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_MAX_STEPS;
  const openrouterBaseURL =
    (source.OPENROUTER_BASE_URL ?? "").trim() || DEFAULT_OPENROUTER_BASE_URL;
  const litellmBaseURL =
    (source.LITELLM_BASE_URL ?? "").trim() || DEFAULT_LITELLM_BASE_URL;
  const litellmKey = (source.LITELLM_API_KEY ?? "").trim();
  const openrouterKey = (source.OPENROUTER_API_KEY ?? "").trim();
  return {
    hasApiKey: litellmKey.length > 0 || openrouterKey.length > 0,
    model,
    maxSteps,
    baseURL: litellmKey.length > 0 ? litellmBaseURL : openrouterBaseURL,
    providers: [
      {
        id: "litellm",
        label: "LiteLLM",
        baseURL: litellmBaseURL,
        hasApiKey: litellmKey.length > 0,
        primary: litellmKey.length > 0,
      },
      {
        id: "openrouter",
        label: "OpenRouter",
        baseURL: openrouterBaseURL,
        hasApiKey: openrouterKey.length > 0,
        primary: false,
      },
    ],
  };
}

/**
 * Resolve which provider a run's model routes through. `auto` (and explicit
 * `litellm/` ids) go through the LiteLLM proxy; every other id is a concrete
 * model served by OpenRouter.
 */
export function resolveModelProvider(
  model: string | undefined,
  env: EnvStatus,
): ModelProviderId {
  const target = (model ?? "").trim() || env.model;
  if (isLitellmAlias(target) || target.startsWith("litellm/")) return "litellm";
  return "openrouter";
}

/** Credentials for a provider, read from the same source as {@link envStatus}. */
export function providerEndpoint(
  providerId: ModelProviderId,
  source: Record<string, string | undefined> = process.env,
): { apiKey: string | undefined; baseURL: string | undefined } {
  const baseURL =
    providerId === "litellm"
      ? (source.LITELLM_BASE_URL ?? "").trim() || DEFAULT_LITELLM_BASE_URL
      : (source.OPENROUTER_BASE_URL ?? "").trim() ||
        DEFAULT_OPENROUTER_BASE_URL;
  const apiKey =
    providerId === "litellm"
      ? (source.LITELLM_API_KEY ?? "").trim() || undefined
      : (source.OPENROUTER_API_KEY ?? "").trim() || undefined;
  return { apiKey, baseURL };
}
