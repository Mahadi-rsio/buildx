import { randomUUID } from "node:crypto";
import { isTerminalStatus } from "@buildx/shared";
import {
  claimNextQueuedRun,
  getDb,
  heartbeatRun,
  isRunCancelled,
  recoverTimedOutRuns,
  releaseRunLease,
  releaseWorkspaceLock,
  renewWorkspaceLock,
  acquireWorkspaceLock,
  sql,
  type Db,
} from "@buildx/db";
import { startRun } from "./runner";
import {
  appendEvent,
  finishRun,
  flushAppends,
  getRun,
  type TerminalRunStatus,
} from "./store";

const LEASE_TTL_MS = 60_000;
const LOCK_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const CLAIM_BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const workerState = globalThis as unknown as {
  __BUILDX_WORKER_STOPPED__?: boolean;
};

function panic(err: unknown): void {
  // Surface startup errors (e.g. a guard that detects a misconfigured
  // sandbox) loudly instead of silently idling.
  console.error("[buildx-worker]", err);
}

/**
 * Claim the oldest queued run this worker can execute (respecting the
 * per-user single-running invariant and the workspace lock), execute it under
 * a renewable lease, and clean up after it. Returns `true` when a run was
 * processed so the loop can poll again promptly.
 */
async function processNextRun(db: Db): Promise<boolean> {
  // Recover leases that expired under another process (or this one before the
  // heartbeat kicked in) before claiming, so stalled runs can move on.
  await recoverTimedOutRuns(db).then((recovered) => {
    if (recovered > 0) console.log(`[buildx-worker] recovered ${recovered} stalled run(s)`);
  });

  const leaseId = randomUUID();
  const claimed = await claimNextQueuedRun(db, { leaseId, leaseTtlMs: LEASE_TTL_MS });
  if (!claimed) return false;

  const run = await getRun(claimed.id);
  if (!run) {
    await releaseRunLease(db, { runId: claimed.id, leaseId });
    return false;
  }

  // The workspace lock serializes access to the user's persistent workspace
  // (belt-and-suspenders on top of the per-user single-running guard). If it's
  // busy, hand the lease back and retry later.
  const workspaceId = run.id;
  const lockOk = await acquireWorkspaceLock(db, {
    workspaceId,
    leaseId,
    ttlMs: LOCK_TTL_MS,
  });
  if (!lockOk) {
    await releaseRunLease(db, { runId: run.id, leaseId });
    return false;
  }

  const heartbeat = setInterval(() => {
    void heartbeatRun(db, { runId: run.id, leaseId, leaseTtlMs: LEASE_TTL_MS }).then(
      (stillOurs) => {
        if (!stillOurs) return;
        void renewWorkspaceLock(db, { workspaceId, leaseId, ttlMs: LOCK_TTL_MS });
      },
    );
  }, HEARTBEAT_MS);

  const stop = async (): Promise<void> => {
    clearInterval(heartbeat);
    await releaseWorkspaceLock(db, { workspaceId, leaseId });
    // No-op when the lease was already released by a terminal `finishRun`.
    await releaseRunLease(db, { runId: run.id, leaseId });
  };

  try {
    const cancelState = await isRunCancelled(db, run.id);
    if (cancelState.cancelled) {
      await finalizeEarly(run, cancelState.reason ?? "stopped before the agent started");
      return true;
    }
    await startRun(run);
    // `startRun` can return without a terminal transition only when its
    // early-abort guard fired; finalize from the persisted cancel flag so the
    // lease never silently expires.
    if (!isTerminalStatus(run.status)) {
      const cancelled = await isRunCancelled(db, run.id);
      await finalizeEarly(
        run,
        cancelled.reason ??
          (cancelled.cancelled
            ? "stopped before the agent started"
            : "the worker lost the run"),
        cancelled.cancelled ? "cancelled" : "failed",
      );
    }
    return true;
  } finally {
    await stop();
  }
}

/** Append the terminal status event, flush, and run the guarded finalize. */
async function finalizeEarly(
  run: Parameters<typeof startRun>[0],
  message: string,
  status: TerminalRunStatus = "cancelled",
): Promise<void> {
  try {
    await appendEvent(run, {
      type: "status",
      data: { status, message },
      ts: Date.now(),
    });
    await flushAppends(run.id);
    await finishRun(run, status, message);
  } catch (error) {
    console.error("[buildx-worker] finalize failed", error);
  }
}

/**
 * Durable job worker: claims leases, heartbeats them, executes runs detachantly
 * from the request that created them, and recovers stalled work. Runs one loop
 * per process until `stopWorker` is called. The run loop never rejects — errors
 * are logged and the loop continues.
 */
export async function runWorker(options?: { signal?: AbortSignal }): Promise<void> {
  const db = getDb();
  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    panic(error);
    return;
  }

  const signal = options?.signal;
  if (workerState.__BUILDX_WORKER_STOPPED__) return;

  while (!workerState.__BUILDX_WORKER_STOPPED__ && !signal?.aborted) {
    const processed = await processNextRun(db).catch((error) => {
      console.error("[buildx-worker] loop iteration failed", error);
      return false;
    });
    await sleep(processed ? 100 : CLAIM_BACKOFF_MS);
  }
}

/** Signal the worker loop to stop after the current iteration. */
export function stopWorker(): void {
  workerState.__BUILDX_WORKER_STOPPED__ = true;
}