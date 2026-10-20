import { z } from "zod";

/** Model → context-window metadata used to render live context stats. */
export { getModelContextWindow } from "./model-context";

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

export interface ApprovalPayload {
  toolCallId: string;
  command: string;
  status: "pending" | "approved" | "denied";
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
}

export type WorkspaceEventStatus =
  | "workspace.restoring"
  | "workspace.ready"
  | "workspace.archiving"
  | "workspace.archived";

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
  VERCEL_AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  VERCEL_AI_GATEWAY_BASE_URL: z.string().min(1).optional(),
  LITELLM_API_KEY: z.string().min(1).optional(),
  LITELLM_BASE_URL: z.string().min(1).optional(),
});
export type Env = z.infer<typeof envSchema>;

/**
 * The model provider a run routes through: the LiteLLM proxy for `auto`, or
 * the Vercel AI Gateway for concrete gateway model ids.
 */
export type ModelProviderId = "litellm" | "vercel";

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = [
  "litellm",
  "vercel",
];

export const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000/v1";
export const DEFAULT_VERCEL_BASE_URL = "https://ai-gateway.vercel.sh/v1";

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
  const vercelBaseURL =
    (source.VERCEL_AI_GATEWAY_BASE_URL ?? "").trim() || DEFAULT_VERCEL_BASE_URL;
  const litellmBaseURL =
    (source.LITELLM_BASE_URL ?? "").trim() || DEFAULT_LITELLM_BASE_URL;
  const litellmKey = (source.LITELLM_API_KEY ?? "").trim();
  const vercelKey = (source.VERCEL_AI_GATEWAY_API_KEY ?? "").trim();
  return {
    hasApiKey: litellmKey.length > 0 || (vercelKey.length > 0 && Boolean(vercelBaseURL)),
    model,
    maxSteps,
    baseURL: litellmKey.length > 0 ? litellmBaseURL : vercelBaseURL,
    providers: [
      {
        id: "litellm",
        label: "LiteLLM",
        baseURL: litellmBaseURL,
        hasApiKey: litellmKey.length > 0,
        primary: litellmKey.length > 0,
      },
      {
        id: "vercel",
        label: "Vercel AI Gateway",
        baseURL: vercelBaseURL,
        hasApiKey: vercelKey.length > 0,
        primary: false,
      },
    ],
  };
}

/**
 * Resolve which provider a run's model routes through. `auto` (and explicit
 * `litellm/` ids) go through the LiteLLM proxy; every other id is a concrete
 * model served by the Vercel AI Gateway.
 */
export function resolveModelProvider(
  model: string | undefined,
  env: EnvStatus,
): ModelProviderId {
  const target = (model ?? "").trim() || env.model;
  if (isLitellmAlias(target) || target.startsWith("litellm/")) return "litellm";
  return "vercel";
}

/** Credentials for a provider, read from the same source as {@link envStatus}. */
export function providerEndpoint(
  providerId: ModelProviderId,
  source: Record<string, string | undefined> = process.env,
): { apiKey: string | undefined; baseURL: string | undefined } {
  const baseURL =
    providerId === "litellm"
      ? (source.LITELLM_BASE_URL ?? "").trim() || DEFAULT_LITELLM_BASE_URL
      : (source.VERCEL_AI_GATEWAY_BASE_URL ?? "").trim() ||
        DEFAULT_VERCEL_BASE_URL;
  const apiKey =
    providerId === "litellm"
      ? (source.LITELLM_API_KEY ?? "").trim() || undefined
      : (source.VERCEL_AI_GATEWAY_API_KEY ?? "").trim() || undefined;
  return { apiKey, baseURL };
}
