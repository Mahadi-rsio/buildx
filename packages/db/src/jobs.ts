import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { runs, workspaceLocks, type RunStatus } from "./schema";

/**
 * Distributed job primitives for the run queue (arcetecture.md §9, plan phases
 * 1–3). Every claim/heartbeat/transition is guarded by row-level conditions, so
 * multiple Next.js instances can run the same worker loop without double
 * executing a run or stomping each other's leases.
 */

/** How long a claimed run's lease lives between heartbeats. */
export const RUN_LEASE_TTL_MS = 30_000;
/** Workspace lock lease; grants exclusive workspace mutation for a run. */
export const WORKSPACE_LOCK_TTL_MS = 60_000;

export type RunRow = typeof runs.$inferSelect;

const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];

/**
 * Atomically claim the oldest queued run. Uses `FOR UPDATE SKIP LOCKED` so two
 * workers never claim the same row, and skips runs whose user already has a
 * running run (enforced in the DB by `runs_one_active_per_user_idx`, so the
 * claim must never `UPDATE` a second row to `running` at the same time).
 * Returns the claimed run or `null`.
 */
export async function claimNextQueuedRun(
  db: Db,
  input: { leaseId: string; leaseTtlMs?: number },
): Promise<RunRow | null> {
  const ttl = input.leaseTtlMs ?? RUN_LEASE_TTL_MS;
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT r.id FROM runs r
      WHERE r.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM runs other
          WHERE other.user_id = r.user_id
            AND other.status = 'running'
        )
      ORDER BY r.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE runs
    SET status = 'running',
        lease_id = ${input.leaseId},
        fencing_token = runs.fencing_token + 1,
        lease_expires_at = now() + make_interval(secs => ${ttl / 1000}),
        started_at = COALESCE(started_at, now()),
        updated_at = now()
    WHERE id IN (SELECT id FROM candidate)
    RETURNING id
  `);
  const { rows } = result as unknown as { rows: Array<{ id: string }> };
  if (!rows[0]) return null;
  const rows2 = await db
    .select()
    .from(runs)
    .where(eq(runs.id, rows[0].id));
  return rows2[0] ?? null;
}

/**
 * Recover abandoned work. Runs stuck in `running` past their lease expiry are
 * requeued (or cancelled outright when a cancellation was already requested).
 * Expired workspace locks are deleted so the workspace can be re-acquired.
 */
export async function recoverTimedOutRuns(
  db: Db,
  now: Date = new Date(),
): Promise<number> {
  const ts = now.toISOString();
  const expired = sql`${runs.leaseExpiresAt} < ${ts}::timestamptz OR (${runs.status} = 'running' AND ${runs.leaseExpiresAt} IS NULL AND ${runs.startedAt} < (${ts}::timestamptz - interval '5 minutes'))`;
  const requeued = await db
    .update(runs)
    .set({
      status: "queued",
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(runs.status, "running"), isNull(runs.cancelledAt), expired));
  const cancelled = await db
    .update(runs)
    .set({
      status: "cancelled",
      leaseId: null,
      leaseExpiresAt: null,
      endedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(runs.status, "running"), sql`${runs.cancelledAt} IS NOT NULL`, expired));
  await db
    .delete(workspaceLocks)
    .where(sql`${workspaceLocks.expiresAt} < ${ts}::timestamptz`);
  return (requeued.rowCount ?? 0) + (cancelled.rowCount ?? 0);
}

/**
 * Extend the caller's lease. Returns false when the run is no longer ours
 * (recovered by another worker, or the row vanished) and the worker must stop.
 */
export async function heartbeatRun(
  db: Db,
  input: {
    runId: string;
    leaseId: string;
    fencingToken?: number;
    leaseTtlMs?: number;
  },
): Promise<boolean> {
  const ttl = input.leaseTtlMs ?? RUN_LEASE_TTL_MS;
  const guarded = and(
    eq(runs.id, input.runId),
    eq(runs.leaseId, input.leaseId),
    eq(runs.status, "running"),
    input.fencingToken !== undefined
      ? eq(runs.fencingToken, input.fencingToken)
      : sql`true`,
  );
  const rows = await db
    .update(runs)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${ttl / 1000})`,
      updatedAt: sql`now()`,
    })
    .where(guarded)
    .returning({ id: runs.id });
  return rows.length === 1;
}

/** Drop the run's lease (called on the release path of the execute loop). */
export async function releaseRunLease(
  db: Db,
  input: { runId: string; leaseId: string; fencingToken?: number },
): Promise<boolean> {
  const guarded = and(
    eq(runs.id, input.runId),
    eq(runs.leaseId, input.leaseId),
    input.fencingToken !== undefined
      ? eq(runs.fencingToken, input.fencingToken)
      : sql`true`,
  );
  const rows = await db
    .update(runs)
    .set({ leaseId: null, leaseExpiresAt: null, updatedAt: sql`now()` })
    .where(guarded)
    .returning({ id: runs.id });
  return rows.length === 1;
}

/**
 * Requeue a running run back to queued state on lock contention or clean yield.
 * If cancellation was requested in the interim, transitions to cancelled instead.
 * Guarded by leaseId and running status so newer worker state is never overwritten.
 */
export async function requeueRun(
  db: Db,
  input: { runId: string; leaseId: string; fencingToken?: number },
): Promise<boolean> {
  const guarded = and(
    eq(runs.id, input.runId),
    eq(runs.leaseId, input.leaseId),
    eq(runs.status, "running"),
    input.fencingToken !== undefined
      ? eq(runs.fencingToken, input.fencingToken)
      : sql`true`,
  );
  const rows = await db
    .update(runs)
    .set({
      status: sql`CASE WHEN ${runs.cancelledAt} IS NOT NULL THEN 'cancelled'::text ELSE 'queued'::text END`,
      leaseId: null,
      leaseExpiresAt: null,
      startedAt: sql`CASE WHEN ${runs.cancelledAt} IS NOT NULL THEN ${runs.startedAt} ELSE NULL END`,
      endedAt: sql`CASE WHEN ${runs.cancelledAt} IS NOT NULL THEN now() ELSE NULL END`,
      updatedAt: sql`now()`,
    })
    .where(guarded)
    .returning({ id: runs.id });
  return rows.length === 1;
}

/**
 * Persist a cancellation request. Only succeeds while the run is still
 * non-terminal and not already cancelled; the executing worker observes the
 * flag and stops the machine. Returns whether the flag was newly set.
 */
export async function requestCancellation(
  db: Db,
  input: { runId: string; reason?: string },
): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({
      cancelledAt: sql`now()`,
      cancelReason: input.reason ?? null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(runs.id, input.runId),
        notInArray(runs.status, TERMINAL),
        isNull(runs.cancelledAt),
      ),
    )
    .returning({ id: runs.id });
  return rows.length === 1;
}

/** Whether the run carries a pending cancellation flag. */
export async function isRunCancelled(
  db: Db,
  runId: string,
): Promise<{ cancelled: boolean; reason: string | null }> {
  const rows = await db
    .select({ cancelledAt: runs.cancelledAt, cancelReason: runs.cancelReason })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];
  return { cancelled: Boolean(row?.cancelledAt), reason: row?.cancelReason ?? null };
}

/**
 * One-round-trip control-plane read for a run: whether a cancellation is
 * pending and whether the caller still owns the lease. The executing worker
 * polls this between agent steps so it stops promptly on `/stop` and fences
 * itself the moment another instance takes over its lease.
 */
export async function readRunControl(
  db: Db,
  input: { runId: string; leaseId: string; fencingToken?: number },
): Promise<{
  cancelled: boolean;
  reason: string | null;
  ownsLease: boolean;
}> {
  const rows = await db
    .select({
      cancelledAt: runs.cancelledAt,
      cancelReason: runs.cancelReason,
      leaseId: runs.leaseId,
      fencingToken: runs.fencingToken,
      leaseExpiresAt: runs.leaseExpiresAt,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, input.runId));
  const row = rows[0];
  if (!row) return { cancelled: false, reason: null, ownsLease: false };

  const matchesLease = row.leaseId === input.leaseId;
  const matchesToken =
    input.fencingToken === undefined || row.fencingToken === input.fencingToken;
  const notExpired =
    !row.leaseExpiresAt || row.leaseExpiresAt.getTime() >= Date.now();
  const notTerminal = !TERMINAL.includes(row.status);
  const ownsLease = matchesLease && matchesToken && notExpired && notTerminal;

  return {
    cancelled: Boolean(row.cancelledAt),
    reason: row.cancelReason ?? null,
    ownsLease,
  };
}

/**
 * Terminal transition guarded by (a) we still own the lease and (b) the run is
 * not already terminal. For `completed`/`failed` the run must NOT have been
 * cancelled; for `cancelled` it must HAVE been (the worker answers an external
 * stop request). Also enforces that the lease has not expired. Returns whether
 * the transition happened.
 */
export async function finalizeRun(
  db: Db,
  input: {
    runId: string;
    leaseId: string;
    fencingToken?: number;
    status: Exclude<RunStatus, "queued" | "running" | "waiting_input">;
    error?: string | null;
  },
): Promise<boolean> {
  const guarded = and(
    eq(runs.id, input.runId),
    eq(runs.leaseId, input.leaseId),
    input.fencingToken !== undefined
      ? eq(runs.fencingToken, input.fencingToken)
      : sql`true`,
    notInArray(runs.status, TERMINAL),
    input.status === "cancelled"
      ? sql`${runs.cancelledAt} IS NOT NULL`
      : isNull(runs.cancelledAt),
    sql`(${runs.leaseExpiresAt} IS NULL OR ${runs.leaseExpiresAt} >= now())`,
  );
  const rows = await db
    .update(runs)
    .set({
      status: input.status,
      endedAt: sql`now()`,
      error: input.error ?? null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(guarded)
    .returning({ id: runs.id });
  return rows.length === 1;
}

/**
 * Ownership-safe event insertion guarded atomically in PostgreSQL.
 * Inserts only if the run is currently owned by `leaseId` (and `fencingToken`),
 * the lease has not expired, the run is not in a terminal state, and either:
 * - the run is not cancelled, OR
 * - the event is the terminal cancellation status event closing the run.
 * Returns the inserted event id and timestamp, or null when ownership/lease
 * condition was not met.
 */
export async function appendGuardedEvent(
  db: Db,
  input: {
    runId: string;
    leaseId?: string;
    fencingToken?: number;
    type: string;
    payload: unknown;
    createdAt?: Date;
  },
): Promise<{ id: number; createdAt: Date } | null> {
  const ts = input.createdAt ?? new Date();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const isCancellationStatus =
    input.type === "status" &&
    typeof input.payload === "object" &&
    input.payload !== null &&
    (input.payload as Record<string, unknown>).status === "cancelled";

  const result = await db.execute(sql`
    WITH target AS (
      SELECT id FROM runs
      WHERE id = ${input.runId}::uuid
        AND status NOT IN ('completed', 'failed', 'cancelled')
        AND (
          (${input.leaseId ?? null}::text IS NULL AND lease_id IS NULL)
          OR
          (
            ${input.leaseId ?? null}::text IS NOT NULL
            AND lease_id = ${input.leaseId ?? null}
            AND (${input.fencingToken ?? null}::integer IS NULL OR fencing_token = ${input.fencingToken ?? null})
            AND (lease_expires_at IS NULL OR lease_expires_at >= now())
          )
        )
        AND (
          cancelled_at IS NULL
          OR ${isCancellationStatus}
        )
    )
    INSERT INTO events (run_id, type, payload, created_at)
    SELECT id, ${input.type}, ${payloadJson}::jsonb, ${ts}::timestamptz
    FROM target
    RETURNING id, created_at
  `);

  const { rows } = result as unknown as {
    rows: Array<{ id: number | string; created_at: Date | string }>;
  };
  if (!rows || !rows[0]) return null;
  return {
    id: Number(rows[0].id),
    createdAt: new Date(rows[0].created_at),
  };
}

/**
 * Acquire the exclusive lock on a workspace. Succeeds when (a) the row is free,
 * (b) the previous lease expired, or (c) we already own it. Returns whether we
 * hold the lock.
 */
export async function acquireWorkspaceLock(
  db: Db,
  input: { workspaceId: string; leaseId: string; ttlMs?: number },
): Promise<boolean> {
  const ttl = input.ttlMs ?? WORKSPACE_LOCK_TTL_MS;
  const rows = await db.execute(sql`
    INSERT INTO workspace_locks (workspace_id, lease_id, expires_at, created_at, updated_at)
    VALUES (${input.workspaceId}, ${input.leaseId}, now() + make_interval(secs => ${ttl / 1000}), now(), now())
    ON CONFLICT (workspace_id) DO UPDATE
    SET lease_id = EXCLUDED.lease_id,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    WHERE workspace_locks.expires_at < now()
       OR workspace_locks.lease_id = EXCLUDED.lease_id
    RETURNING workspace_id
  `);
  return rows.rowCount === 1;
}

/** Keep the workspace lock alive. False when we no longer own it. */
export async function renewWorkspaceLock(
  db: Db,
  input: { workspaceId: string; leaseId: string; ttlMs?: number },
): Promise<boolean> {
  const ttl = input.ttlMs ?? WORKSPACE_LOCK_TTL_MS;
  const rows = await db
    .update(workspaceLocks)
    .set({ expiresAt: sql`now() + make_interval(secs => ${ttl / 1000})`, updatedAt: sql`now()` })
    .where(
      and(
        eq(workspaceLocks.workspaceId, input.workspaceId),
        eq(workspaceLocks.leaseId, input.leaseId),
      ),
    )
    .returning({ workspaceId: workspaceLocks.workspaceId });
  return rows.length === 1;
}

/** Drop the workspace lock, but only while it is still ours. */
export async function releaseWorkspaceLock(
  db: Db,
  input: { workspaceId: string; leaseId: string },
): Promise<boolean> {
  const rows = await db
    .delete(workspaceLocks)
    .where(
      and(
        eq(workspaceLocks.workspaceId, input.workspaceId),
        eq(workspaceLocks.leaseId, input.leaseId),
      ),
    )
    .returning({ workspaceId: workspaceLocks.workspaceId });
  return rows.length === 1;
}