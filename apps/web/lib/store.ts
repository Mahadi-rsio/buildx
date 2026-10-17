import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL, isTerminalStatus } from "@buildx/shared";
import type { RunEvent, RunEventInput, RunStatus } from "@buildx/shared";
import { and, asc, desc, eq, getDb, runs as runsTable, events as eventsTable } from "@buildx/db";
import { workspaceDirFor } from "./paths";
import type {
  RunDetail,
  RunStats,
  RunSummary,
  WorkspaceRuntime,
  WorkspaceUsage,
} from "./types";
import type { Baseline } from "./workspace-fs";

/** Trigger lazy baseline capture on first diff request (arcetecture §6). */
export const captureBaseline = Symbol.for("__buildx.captureBaseline");

export interface StoredRun {
  id: string;
  userId: string;
  workspaceName: string;
  task: string;
  status: RunStatus;
  model: string;
  maxSteps: number;
  /** Absolute path of the sandbox workspace root for this run. */
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  stats?: RunStats;
  /** Append-only event log (arcetecture.md §4), cached per process. */
  events: RunEvent[];
  /** Live SSE subscribers waiting for the next event (process-local). */
  subscribers: Set<(event: RunEvent) => void>;
  /** Aborted by `POST /api/runs/:id/stop` (process-local). */
  controller: AbortController;
  /** Run-start snapshot for the workspace diff (arcetecture §6). Capture is
   *  lazy: the first `GET /api/workspaces/:id/diff` fills this when missing. */
  baseline?: Baseline;
  /** Workspace lifecycle + quota state surfaced by Phase 10 UI (process-local). */
  workspace: WorkspaceRuntime;
}

type RunRow = typeof runsTable.$inferSelect;

/**
 * DB-backed run/event store. Durable fields live in Postgres (`runs` +
 * `events` rows); the process-local overlay below only holds what cannot be
 * persisted — SSE subscriber sets, AbortControllers, the lazy diff baseline,
 * and the transient workspace-quota view. A run is hydrated from Postgres on
 * first touch after a process restart, so runs survive dev-server reloads.
 */
const globalForStore = globalThis as unknown as {
  __BUILDX_RUNS__?: Map<string, StoredRun>;
};

function cachedRuns(): Map<string, StoredRun> {
  if (!globalForStore.__BUILDX_RUNS__) {
    globalForStore.__BUILDX_RUNS__ = new Map();
  }
  return globalForStore.__BUILDX_RUNS__;
}

function freshRuntime(): {
  subscribers: StoredRun["subscribers"];
  controller: StoredRun["controller"];
  workspace: WorkspaceRuntime;
} {
  return {
    subscribers: new Set(),
    controller: new AbortController(),
    workspace: { status: "idle" },
  };
}

/** Copy durable row fields onto a run object. */
function syncFromRow(run: StoredRun, row: RunRow): void {
  run.userId = row.userId;
  run.workspaceName = row.workspaceName ?? "workspace";
  run.task = row.task ?? "";
  run.status = row.status;
  run.model = row.model ?? DEFAULT_MODEL;
  run.maxSteps = row.maxSteps;
  run.updatedAt = row.updatedAt.getTime();
  run.error = row.error ?? undefined;
  const hasUsage =
    row.stepCount > 0 || row.inputTokens > 0 || row.outputTokens > 0;
  run.stats =
    hasUsage || run.stats
      ? {
          steps: run.stats?.steps ?? row.stepCount ?? 0,
          usage:
            run.stats?.usage ?? {
              inputTokens: row.inputTokens ?? 0,
              outputTokens: row.outputTokens ?? 0,
              totalTokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
            },
        }
      : undefined;
}

/** Hydrate (and remember) a run from its DB row, loading its event log. */
async function hydrateRun(row: RunRow): Promise<StoredRun> {
  const existing = cachedRuns().get(row.id);
  if (existing) {
    syncFromRow(existing, row);
    return existing;
  }

  const runtime = freshRuntime();
  const run: StoredRun = {
    id: row.id,
    userId: row.userId,
    workspaceName: row.workspaceName ?? "workspace",
    task: row.task ?? "",
    status: row.status,
    model: row.model ?? DEFAULT_MODEL,
    maxSteps: row.maxSteps,
    workspaceDir: workspaceDirFor(row.id),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    error: row.error ?? undefined,
    events: [],
    subscribers: runtime.subscribers,
    controller: runtime.controller,
    workspace: runtime.workspace,
  };
  const stats =
    row.stepCount > 0 || row.inputTokens > 0 || row.outputTokens > 0
      ? {
          steps: row.stepCount ?? 0,
          usage: {
            inputTokens: row.inputTokens ?? 0,
            outputTokens: row.outputTokens ?? 0,
            totalTokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
          },
        }
      : undefined;
  run.stats =
    stats && (stats.steps > 0 || (stats.usage?.totalTokens ?? 0) > 0)
      ? stats
      : undefined;
  run.events = await loadEvents(row.id);
  cachedRuns().set(run.id, run);
  return run;
}

async function loadEvents(runId: string): Promise<RunEvent[]> {
  const rows = await getDb()
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.runId, runId))
    .orderBy(asc(eventsTable.id));
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    type: row.type as RunEvent["type"],
    ts: row.createdAt.getTime(),
    data: (row.payload as Record<string, unknown>) ?? {},
  })) as unknown as RunEvent[];
}

export interface CreateRunArgs {
  userId: string;
  workspaceName: string;
  task: string;
  model: string;
  maxSteps: number;
  usage?: WorkspaceUsage;
}

export async function createRun(args: CreateRunArgs): Promise<StoredRun> {
  const db = getDb();

  // Single-instance executor: a `running` row that no process is executing is
  // stale (crashed or killed dev server). Reclaim it so the DB partial unique
  // index (`one active run per user`) can't block new runs. Runs this process
  // is actually executing are left alone. The DB worker that lands later
  // replaces this with lease expiry + heartbeat (arcetecture.md §9).
  const stale = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.userId, args.userId),
        eq(runsTable.status, "running"),
      ),
    );
  for (const row of stale) {
    const active = cachedRuns().get(row.id);
    if (active && !isTerminalStatus(active.status)) continue;
    await db
      .update(runsTable)
      .set({
        status: "failed",
        error: "interrupted by a new run (previous process exited)",
        endedAt: new Date(),
      })
      .where(eq(runsTable.id, row.id));
  }

  const id = randomUUID();
  const now = new Date();
  const [row] = await db
    .insert(runsTable)
    .values({
      id,
      userId: args.userId,
      model: args.model,
      status: "queued",
      task: args.task,
      workspaceName: args.workspaceName,
      maxSteps: args.maxSteps,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const runtime = freshRuntime();
  runtime.workspace.usage = args.usage;
  const run: StoredRun = {
    id: row.id,
    userId: row.userId,
    workspaceName: row.workspaceName ?? "workspace",
    task: row.task ?? "",
    status: "queued",
    model: row.model ?? DEFAULT_MODEL,
    maxSteps: row.maxSteps,
    workspaceDir: workspaceDirFor(row.id),
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
    events: [],
    subscribers: runtime.subscribers,
    controller: runtime.controller,
    workspace: runtime.workspace,
  };
  cachedRuns().set(run.id, run);
  return run;
}

/** Resolve a run by id, hydrating from Postgres on a cache miss. */
export async function getRun(id: string): Promise<StoredRun | undefined> {
  const cached = cachedRuns().get(id);
  if (cached) return cached;
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, id));
  if (!row) return undefined;
  return hydrateRun(row);
}

/** Resolve a run by its workspace id (equal to the run id today). */
export async function getRunByWorkspaceId(
  workspaceId: string,
): Promise<StoredRun | undefined> {
  return getRun(workspaceId);
}

/** The caller's runs, newest first (Postgres is the source of truth). */
export async function listRunsForUser(userId: string): Promise<StoredRun[]> {
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.userId, userId))
    .orderBy(desc(runsTable.createdAt));
  const runs: StoredRun[] = [];
  for (const row of rows) {
    runs.push(await hydrateRun(row));
  }
  return runs;
}

/**
 * Append an event: persist it to the `events` row, assign its DB-assigned id,
 * remember it on the run, and fan it out to live SSE subscribers.
 */
export async function appendEvent(
  run: StoredRun,
  input: RunEventInput,
): Promise<RunEvent> {
  const db = getDb();
  const ts = new Date(input.ts);
  const [row] = await db
    .insert(eventsTable)
    .values({
      runId: run.id,
      type: input.type,
      payload: JSON.parse(JSON.stringify(input.data)),
      createdAt: ts,
    })
    .returning({ id: eventsTable.id, createdAt: eventsTable.createdAt });

  const event = {
    ...input,
    id: row.id,
    runId: run.id,
    ts: row.createdAt.getTime(),
  } as RunEvent;
  run.events.push(event);
  run.updatedAt = event.ts;

  for (const subscriber of [...run.subscribers]) {
    try {
      subscriber(event);
    } catch {
      run.subscribers.delete(subscriber);
    }
  }
  return event;
}

/** Mark a run as executing (persists status and started_at). */
export async function markRunning(run: StoredRun): Promise<void> {
  run.status = "running";
  run.updatedAt = Date.now();
  await getDb()
    .update(runsTable)
    .set({ status: "running", updatedAt: new Date(run.updatedAt) })
    .where(eq(runsTable.id, run.id));
}

/** Persist step/usage counters surfaced on the run summary. */
export async function persistStats(run: StoredRun): Promise<void> {
  const usage = run.stats?.usage;
  await getDb()
    .update(runsTable)
    .set({
      stepCount: run.stats?.steps ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(runsTable.id, run.id));
}

/** Move a run to a (usually terminal) status, remembering the failure reason. */
export async function finishRun(
  run: StoredRun,
  status: RunStatus,
  error?: string,
): Promise<void> {
  run.status = status;
  run.updatedAt = Date.now();
  if (error !== undefined) run.error = error;
  const terminal = isTerminalStatus(status);
  await getDb()
    .update(runsTable)
    .set({
      status,
      error: error ?? run.error ?? null,
      ...(terminal ? { endedAt: new Date() } : {}),
      updatedAt: new Date(run.updatedAt),
    })
    .where(eq(runsTable.id, run.id));
}

export function isRunning(run: StoredRun): boolean {
  return !isTerminalStatus(run.status);
}

export function toRunSummary(run: StoredRun): RunSummary {
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    model: run.model,
    maxSteps: run.maxSteps,
    workspaceId: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    error: run.error,
    stats: run.stats,
    workspace: run.workspace,
    eventCount: run.events.length,
  };
}

export function toRunDetail(run: StoredRun): RunDetail {
  return { ...toRunSummary(run), events: run.events };
}