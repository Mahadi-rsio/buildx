import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL, isTerminalStatus } from "@buildx/shared";
import type { RunEvent, RunEventInput, RunStatus } from "@buildx/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  finalizeRun,
  getDb,
  requestCancellation,
  events as eventsTable,
  runs as runsTable,
} from "@buildx/db";
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
  /** Lease id owning this run while it is being executed (set by the worker). */
  leaseId?: string;
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
  run.leaseId = row.leaseId ?? undefined;
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
    leaseId: row.leaseId ?? undefined,
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
  /** Optional client-supplied key: a repeat request with the same key returns
   *  the original run instead of queuing a second one. */
  idempotencyKey?: string;
}

function enqueueNow(): { createdAt: Date; updatedAt: Date } {
  const now = new Date();
  return { createdAt: now, updatedAt: now };
}

/**
 * Enqueue a run. Executes as a single `INSERT` of a `queued` row and hands
 * execution to the lease-based job worker (arcetecture.md §9); the request
 * does not drive the run anymore. Duplicate submissions with the same
 * `idempotencyKey` (or a racing retry hitting the unique index) return the
 * already-queued run.
 */
export async function createRun(args: CreateRunArgs): Promise<StoredRun> {
  const db = getDb();

  if (args.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(runsTable)
      .where(
        and(
          eq(runsTable.userId, args.userId),
          eq(runsTable.idempotencyKey, args.idempotencyKey),
        ),
      );
    if (existing) return hydrateRun(existing);
  }

  const id = randomUUID();
  const timestamps = enqueueNow();
  const row = await db
    .insert(runsTable)
    .values({
      id,
      userId: args.userId,
      model: args.model,
      status: "queued",
      task: args.task,
      workspaceName: args.workspaceName,
      maxSteps: args.maxSteps,
      idempotencyKey: args.idempotencyKey ?? null,
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.updatedAt,
    })
    .returning()
    .then((rows) => rows[0])
    .catch(async (error: unknown) => {
      const unique =
        (error as { code?: string })?.code === "23505" &&
        (error as { constraint?: string })?.constraint !==
          "runs_one_active_per_user_idx";
      if (!unique) throw error;
      const [existing] = await db
        .select()
        .from(runsTable)
        .where(
          and(
            eq(runsTable.userId, args.userId),
            eq(runsTable.idempotencyKey, args.idempotencyKey ?? ""),
          ),
        );
      if (!existing) throw error;
      return existing;
    });

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
    createdAt: row.createdAt.getTime() ?? Date.now(),
    updatedAt: row.updatedAt.getTime() ?? Date.now(),
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

/** Resolve the DB row for a run, hydrating the cache on a miss. */
export async function getRunRow(id: string): Promise<RunRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, id));
  if (!row) return undefined;
  return row;
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
 * Serialize + persist an event append. Appends to the same run are chained on
 * a per-run tail promise so the *storage order* matches the caller order even
 * when callers race (flush-then-finalize in the runner relies on this).
 */
const appendTails = new Map<string, Promise<unknown>>();

function enqueueAppend<T>(
  runId: string,
  task: () => T | Promise<T>,
): Promise<T> {
  const previous = appendTails.get(runId) ?? Promise.resolve();
  const next = previous.then(task);
  next.catch(() => {
    // A failed append must not reject/pause later appends; each caller still
    // observes its own error through the returned promise.
  });
  appendTails.set(runId, next);
  return next;
}

/** Drain the append queue for a run — await before finalizing so every event
 *  this process emitted is in Postgres first. */
export async function flushAppends(...runIds: string[]): Promise<void> {
  await Promise.all(
    runIds.map((runId) =>
      Promise.resolve(appendTails.get(runId) ?? Promise.resolve()),
    ),
  );
}

/**
 * Append an event: persist it to the `events` row, assign its DB-assigned id,
 * remember it on the run, and fan it out to live SSE subscribers. Appends to
 * one run are serialized; concurrent callers see run-consistent ordering.
 */
export function appendEvent(
  run: StoredRun,
  input: RunEventInput,
): Promise<RunEvent> {
  return enqueueAppend(run.id, () => doAppendEvent(run, input));
}

async function doAppendEvent(
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

/** Persist step/usage counters surfaced on the run summary. Skipped when we no
 *  longer own the run's lease (it was reclaimed by another worker). */
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
    .where(
      run.leaseId
        ? and(eq(runsTable.id, run.id), eq(runsTable.leaseId, run.leaseId))
        : eq(runsTable.id, run.id),
    );
}

/** Statuses a run can be finalized as (only terminal transitions are legal). */
export type TerminalRunStatus = Exclude<
  RunStatus,
  "queued" | "running" | "waiting_input"
>;

/**
 * Move a run to a (usually terminal) status, remembering the failure reason.
 * Uses the lease-guarded transition in `packages/db`, so a lost lease makes
 * the write a no-op (the reclaiming worker owns the row now). Returns whether
 * the transition ran; subsequent callers should re-read the row for truth.
 */
export async function finishRun(
  run: StoredRun,
  status: TerminalRunStatus,
  error?: string,
): Promise<boolean> {
  const applied = await finalizeRun(getDb(), {
    runId: run.id,
    leaseId: run.leaseId ?? "",
    status,
    error,
  });
  if (applied) {
    run.status = status;
    run.updatedAt = Date.now();
    if (error !== undefined) run.error = error;
    run.leaseId = undefined;
  }
  return applied;
}

/**
 * Cancel a run: persist the durable cancellation request (visible to every
 * worker instance) and abort this process's loop if it happens to be running
 * it. Terminal and already-cancelled runs are a no-op. Returns whether the
 * cancellation was newly requested.
 */
export async function cancelRun(
  run: StoredRun,
  reason?: string,
): Promise<boolean> {
  const newly = await requestCancellation(getDb(), { runId: run.id, reason });
  if (newly && !run.controller.signal.aborted) {
    run.controller.abort();
  }
  return newly;
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

export async function toRunDetail(run: StoredRun): Promise<RunDetail> {
  const events = await loadEvents(run.id);
  return { ...toRunSummary(run), events };
}

export interface RunSnapshot {
  status: RunStatus;
  updatedAt: number;
  events: RunEvent[];
}

/**
 * Events appended after `afterId` (exclusive), straight from Postgres so any
 * worker/instance's appends are visible. The current row status rides along
 * so SSE clients can close on terminal without replaying history.
 */
export async function listEventsAfter(
  runId: string,
  afterId: number,
): Promise<RunSnapshot> {
  const [rows, runRows] = await Promise.all([
    getDb()
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.runId, runId), gt(eventsTable.id, afterId)))
      .orderBy(asc(eventsTable.id)),
    getDb()
      .select({ status: runsTable.status, updatedAt: runsTable.updatedAt })
      .from(runsTable)
      .where(eq(runsTable.id, runId)),
  ]);
  const run = runRows[0];
  return {
    status: run?.status ?? "failed",
    updatedAt: run?.updatedAt.getTime() ?? 0,
    events: rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      type: row.type as RunEvent["type"],
      ts: row.createdAt.getTime(),
      data: (row.payload as Record<string, unknown>) ?? {},
    })) as unknown as RunEvent[],
  };
}