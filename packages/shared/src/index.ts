import { z } from "zod";

/** Default model id when `AGENT_MODEL` is unset. */
export const DEFAULT_MODEL = "gpt-4o-mini";
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
}

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
}

export interface TerminalPayload {
  stream: "stdout" | "stderr";
  chunk: string;
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

export const createRunSchema = z.object({
  task: z.string().min(1, "task is required"),
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().max(1000).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunSchema>;

export const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().min(1).optional(),
  AGENT_MODEL: z.string().min(1).default(DEFAULT_MODEL),
  AGENT_MAX_STEPS: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(DEFAULT_MAX_STEPS),
});
export type Env = z.infer<typeof envSchema>;

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
}

/**
 * Non-throwing configuration probe for dashboards/config endpoints. Unlike
 * {@link loadEnv} this never throws — it reports whether the key is present and
 * the effective defaults so the UI can explain why a run cannot start.
 */
export function envStatus(
  source: Record<string, string | undefined> = process.env,
): EnvStatus {
  const key = (source.OPENAI_API_KEY ?? "").trim();
  const model = (source.AGENT_MODEL ?? "").trim() || DEFAULT_MODEL;
  const stepsRaw = (source.AGENT_MAX_STEPS ?? "").trim();
  const parsed = Number(stepsRaw);
  const maxSteps =
    stepsRaw && Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_MAX_STEPS;
  return {
    hasApiKey: key.length > 0,
    model,
    maxSteps,
    baseURL: (source.OPENAI_BASE_URL ?? "").trim() || undefined,
  };
}
