import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL, isTerminalStatus } from "@buildx/shared";
import type {
  ConversationTurn,
  RunEvent,
  RunEventInput,
  RunStatus,
} from "@buildx/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  notInArray,
  appendGuardedEvent,
  finalizeRun,
  getDb,
  requestCancellation,
  sql,
  events as eventsTable,
  runs as runsTable,
} from "@buildx/db";
import { workspaceDirFor } from "./paths";
import { cancelRemoteBoxExecution } from "./sandbox";
import type {
  RunDetail,
  RunStats,
  RunSummary,
  WorkspaceRuntime,
  WorkspaceUsage,
} from "./types";
import type { Baseline } from "./workspace-fs";
import type { Db } from "@buildx/db";

/** Trigger lazy baseline capture on first diff request (arcetecture §6). */
export const captureBaseline = Symbol.for("__buildx.captureBaseline");

/** Thrown when a write targets a run this process no longer owns (terminal or
 *  lost its lease). Callers must stop emitting and defer to the run's owner. */
export class StaleRunError extends Error {
  constructor(runId: string, action: string) {
    super(`stale run ${runId}: ${action}`);
    this.name = "StaleRunError";
  }
}

/**
 * Process-local overlay for a run — state that only exists inside this VM and
 * must never be treated as durable or shared across instances.
 */
export interface RunRuntime {
  /** Live SSE subscribers for the next event (see `subscribe`). */
  subscribers: Set<(event: RunEvent) => void>;
  /** Aborted by `/stop`, lease loss, or worker shutdown to stop the loop. */
  controller: AbortController;
  /** Set once this process's lease was reclaimed elsewhere (or expired and
   *  another worker took the run). Every persistent write is fenced by this. */
  lostOwnership: boolean;
  /** Workspace lifecycle + quota state surfaced by the UI (transient view). */
  workspace: WorkspaceRuntime;
  /** Run-start snapshot for the workspace diff (arcetecture §6). Capture is
   *  lazy: the first `GET /api/workspaces/:id/diff` fills this when missing. */
  baseline?: Baseline;
}

export interface StoredRun {
  id: string;
  userId: string;
  /** Durable conversation grouping this and follow-up runs. */
  conversationId?: string;
  workspaceName: string;
  task: string;
  /** Earlier turns replayed before `task` to keep follow-up context. */
  history?: ConversationTurn[];
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
  /** Monotonically increasing fencing token. */
  fencingToken?: number;
  /** Durable view of the claim deadline; refreshed from Postgres, never a
   *  source of truth on its own. */
  leaseExpiresAt?: number;
  /** Append-only event log (arcetecture.md §4), cached per process. */
  events: RunEvent[];
  /** Process-local runtime overlay (subscribers, abort, lost-ownership fence,
   *  workspace view). Never reconstructed from Postgres. */
  runtime: RunRuntime;
}

export type RunRow = typeof runsTable.$inferSelect;

/**
 * DB-backed run/event store. Durable fields live in Postgres (`runs` +
 * `events` rows); the process-local overlay below only holds what cannot be
 * persisted — SSE subscriber sets, AbortControllers, the lazy diff baseline,
 * and the transient workspace-quota view. A run is hydrated from Postgres on
 * first touch after a process restart, so runs survive dev-server reloads.
 * Never conflate `StoredRun.runtime` (this VM) with durable engine state.
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

function freshRuntime(): RunRuntime {
  return {
    subscribers: new Set(),
    controller: new AbortController(),
    lostOwnership: false,
    workspace: { status: "idle" },
  };
}

/** Copy durable row fields onto a run object. Never touches `run.runtime`. */
function syncFromRow(run: StoredRun, row: RunRow): void {
  run.userId = row.userId;
  run.conversationId = row.conversationId ?? undefined;
  run.workspaceName = row.workspaceName ?? "workspace";
  run.task = row.task ?? "";
  run.history = row.history ?? undefined;
  run.status = row.status;
  run.model = row.model ?? DEFAULT_MODEL;
  run.maxSteps = row.maxSteps;
  run.leaseId = row.leaseId ?? undefined;
  run.fencingToken = row.fencingToken ?? 0;
  run.leaseExpiresAt = row.leaseExpiresAt?.getTime() ?? undefined;
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

/**
 * Hydrate (and remember) a run from its DB row. `loadEvents` can be skipped for
 * a row that was just inserted and therefore has no event log yet.
 */
export async function hydrateRun(
  row: RunRow,
  options: { loadEvents?: boolean } = {},
): Promise<StoredRun> {
  const existing = cachedRuns().get(row.id);
  if (existing) {
    syncFromRow(existing, row);
    return existing;
  }

  const runtime = freshRuntime();
  const run: StoredRun = {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId ?? undefined,
    workspaceName: row.workspaceName ?? "workspace",
    task: row.task ?? "",
    history: row.history ?? undefined,
    status: row.status,
    model: row.model ?? DEFAULT_MODEL,
    maxSteps: row.maxSteps,
    workspaceDir: workspaceDirFor(row.id),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    error: row.error ?? undefined,
    leaseId: row.leaseId ?? undefined,
    fencingToken: row.fencingToken ?? 0,
    leaseExpiresAt: row.leaseExpiresAt?.getTime() ?? undefined,
    events: [],
    runtime: runtime,
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
  if (options.loadEvents !== false) {
    run.events = await loadEvents(row.id);
  }
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
  history?: ConversationTurn[];
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
 * already-queued run with `created: false`. `db` may be injected for tests.
 */
export async function createRun(
  args: CreateRunArgs,
  deps?: { db?: Db },
): Promise<{ run: StoredRun; created: boolean }> {
  const db = deps?.db ?? getDb();

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
    if (existing) {
      const run = await hydrateRun(existing);
      return { run, created: false };
    }
  }

  const id = randomUUID();
  const timestamps = enqueueNow();
  let row: RunRow;
  try {
    const rows = await db
      .insert(runsTable)
      .values({
        id,
        userId: args.userId,
        model: args.model,
        status: "queued",
        task: args.task,
        history: args.history?.length ? args.history : null,
        workspaceName: args.workspaceName,
        maxSteps: args.maxSteps,
        idempotencyKey: args.idempotencyKey ?? null,
        createdAt: timestamps.createdAt,
        updatedAt: timestamps.updatedAt,
      })
      .returning();
    row = rows[0];
  } catch (error: unknown) {
    const err = (error as { cause?: unknown }).cause;
    const target = (err && typeof err === "object" ? err : error) as {
      code?: string;
      constraint?: string;
    };
    const unique =
      target.code === "23505" &&
      target.constraint !== "runs_one_active_per_user_idx";
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
    const run = await hydrateRun(existing);
    return { run, created: false };
  }

  const runtime = freshRuntime();
  runtime.workspace.usage = args.usage;
  const run: StoredRun = {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId ?? undefined,
    workspaceName: row.workspaceName ?? "workspace",
    task: row.task ?? "",
    history: row.history ?? undefined,
    status: "queued",
    model: row.model ?? DEFAULT_MODEL,
    maxSteps: row.maxSteps,
    workspaceDir: workspaceDirFor(row.id),
    createdAt: row.createdAt.getTime() ?? Date.now(),
    updatedAt: row.updatedAt.getTime() ?? Date.now(),
    fencingToken: row.fencingToken ?? 0,
    events: [],
    runtime,
  };
  cachedRuns().set(run.id, run);
  return { run, created: true };
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

/**
 * Bind a freshly claimed run row to its process-local record. The claim (not a
 * cached snapshot) is authoritative: it overwrites durable fields and hands the
 * object a fresh AbortController so a run recovered after a lease loss starts
 * clean instead of inheriting an aborted signal. Returns the owned run.
 */
export async function bindClaim(row: RunRow): Promise<StoredRun> {
  const existing = cachedRuns().get(row.id);
  const run = existing ?? (await hydrateRun(row));
  syncFromRow(run, row);
  run.runtime.lostOwnership = false;
  // A new lease owns the run now; whatever this VM did on a previous lease of
  // this same run id is irrelevant. SSE subscribers are part of the runtime and
  // survive (the request path keeps watching the same run object).
  run.runtime.controller = new AbortController();
  return run;
}

/**
 * Re-read a cached run's durable fields from Postgres (the source of truth).
 * Never touches `run.runtime`, so a lease handoff in another instance is
 * reflected here without breaking this VM's live SSE subscribers.
 */
export async function refreshRun(id: string): Promise<StoredRun | undefined> {
  const row = await getRunRow(id);
  if (!row) return undefined;
  const existing = cachedRuns().get(id);
  if (existing) {
    syncFromRow(existing, row);
    return existing;
  }
  return hydrateRun(row);
}

/**
 * Fence this process's run after a lease loss: future persistent writes throw
 * `StaleRunError` and the in-flight agent loop is aborted. Returns the run.
 */
export function markLostOwnership(runId: string): StoredRun | undefined {
  const run = cachedRuns().get(runId);
  if (!run) return undefined;
  if (!run.runtime.lostOwnership) {
    run.runtime.lostOwnership = true;
    run.runtime.controller.abort();
  }
  return run;
}

/** The run this user originally created with `idempotencyKey`, if any. */
export async function getRunForIdempotencyKey(
  userId: string,
  idempotencyKey: string,
  deps?: { db?: Db },
): Promise<StoredRun | undefined> {
  const db = deps?.db ?? getDb();
  const [row] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.userId, userId),
        eq(runsTable.idempotencyKey, idempotencyKey),
      ),
    );
  return row ? hydrateRun(row) : undefined;
}

/**
 * Roll back a freshly queued run when its creating request must be rejected
 * (e.g. the final daily quota slot went to a racing request). Only removes a
 * row still sitting in the queue; once claimed, the row stands on its own.
 */
export async function removeQueuedRun(runId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.status, "queued")));
  cachedRuns().delete(runId);
  return (rows.rowCount ?? 0) > 0;
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
  // The caller observes the real outcome through `next`. The *tail* stored for
  // the next caller is a settled copy, so one failed append (e.g. a lease that
  // just flipped) must never poison the chain and swallow later events.
  appendTails.set(
    runId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
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
 * Rejects with `StaleRunError` when this process no longer owns the run (it
 * went terminal or its lease was reclaimed), so a stale worker can never write
 * events out of order onto a run that already moved on.
 */
export function appendEvent(
  run: StoredRun,
  input: RunEventInput,
  deps?: { db?: Db },
): Promise<RunEvent> {
  return enqueueAppend(run.id, () => doAppendEvent(run, input, deps?.db));
}

async function doAppendEvent(
  run: StoredRun,
  input: RunEventInput,
  dbOverride?: Db,
): Promise<RunEvent> {
  if (run.runtime.lostOwnership) {
    throw new StaleRunError(run.id, "appendEvent after lease loss");
  }
  if (isTerminalStatus(run.status)) {
    throw new StaleRunError(run.id, "appendEvent after terminal status");
  }
  if (
    input.type !== "status" &&
    (run.runtime.controller.signal.aborted || run.status === "cancelled")
  ) {
    throw new StaleRunError(run.id, "appendEvent after run cancellation");
  }
  if (run.leaseExpiresAt && Date.now() >= run.leaseExpiresAt) {
    run.runtime.lostOwnership = true;
    run.runtime.controller.abort();
    throw new StaleRunError(run.id, "appendEvent after lease expired");
  }

  const db = dbOverride ?? getDb();
  const ts = new Date(input.ts);
  const row = await appendGuardedEvent(db, {
    runId: run.id,
    leaseId: run.leaseId,
    fencingToken: run.fencingToken,
    type: input.type,
    payload: input.data,
    createdAt: ts,
  });

  if (!row) {
    run.runtime.lostOwnership = true;
    if (!run.runtime.controller.signal.aborted) {
      run.runtime.controller.abort();
    }
    throw new StaleRunError(
      run.id,
      "event insert rejected: run is no longer owned by this lease or is terminal/expired/cancelled",
    );
  }

  const event = {
    ...input,
    id: row.id,
    runId: run.id,
    ts: row.createdAt.getTime(),
  } as RunEvent;
  run.events.push(event);
  run.updatedAt = event.ts;

  for (const subscriber of [...run.runtime.subscribers]) {
    try {
      subscriber(event);
    } catch {
      run.runtime.subscribers.delete(subscriber);
    }
  }
  return event;
}

/** Persist step/usage counters surfaced on the run summary. Skipped when we no
 *  longer own the run (lease lost or already terminal), so a stale owner's
 *  counters never overwrite the reclaiming worker's values. */
export async function persistStats(run: StoredRun): Promise<void> {
  if (run.runtime.lostOwnership || isTerminalStatus(run.status)) return;
  if (run.leaseExpiresAt && Date.now() >= run.leaseExpiresAt) {
    markLostOwnership(run.id);
    return;
  }
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
        ? and(
            eq(runsTable.id, run.id),
            eq(runsTable.leaseId, run.leaseId),
            run.fencingToken !== undefined
              ? eq(runsTable.fencingToken, run.fencingToken)
              : sql`true`,
            sql`(${runsTable.leaseExpiresAt} IS NULL OR ${runsTable.leaseExpiresAt} >= now())`,
          )
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
  // A fenced process must not act (or appear to act) as the run's owner.
  if (run.runtime.lostOwnership) return false;
  if (run.leaseExpiresAt && Date.now() >= run.leaseExpiresAt) {
    markLostOwnership(run.id);
    return false;
  }
  const applied = await finalizeRun(getDb(), {
    runId: run.id,
    leaseId: run.leaseId ?? "",
    fencingToken: run.fencingToken,
    status,
    error,
  });
  if (applied) {
    run.status = status;
    run.updatedAt = Date.now();
    if (error !== undefined) run.error = error;
    run.leaseId = undefined;
    run.fencingToken = undefined;
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
  const db = getDb();
  const newly = await requestCancellation(db, { runId: run.id, reason });
  if (newly && !run.runtime.controller.signal.aborted) {
    run.runtime.controller.abort();
  }
  // If the run has no active lease or is queued, finalize as cancelled immediately in Neon
  if (!run.leaseId || run.status === "queued") {
    await db
      .update(runsTable)
      .set({
        status: "cancelled",
        endedAt: sql`now()`,
        error: reason ?? "stopped by the user",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(runsTable.id, run.id),
          notInArray(runsTable.status, ["completed", "failed", "cancelled"]),
        ),
      )
      .catch(() => undefined);
    run.status = "cancelled";
  }
  void cancelRemoteBoxExecution(run.userId).catch(() => undefined);
  return newly;
}

export function isRunning(run: StoredRun): boolean {
  return !isTerminalStatus(run.status);
}

export function toRunSummary(run: StoredRun): RunSummary {
  return {
    id: run.id,
    conversationId: run.conversationId,
    task: run.task,
    status: run.status,
    model: run.model,
    maxSteps: run.maxSteps,
    workspaceId: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    error: run.error,
    stats: run.stats,
    workspace: run.runtime.workspace,
    eventCount: run.events.length,
  };
}

export async function toRunDetail(run: StoredRun): Promise<RunDetail> {
  const events = await loadEvents(run.id);
  return { ...toRunSummary(run), events, history: run.history };
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