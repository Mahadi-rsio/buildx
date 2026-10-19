import { randomUUID } from "node:crypto";
import { isTerminalStatus } from "@buildx/shared";
import {
  acquireWorkspaceLock,
  claimNextQueuedRun,
  getDb,
  heartbeatRun,
  readRunControl,
  recoverTimedOutRuns,
  releaseRunLease,
  releaseWorkspaceLock,
  renewWorkspaceLock,
  requeueRun,
  sql,
  type Db,
} from "@buildx/db";
import { startRun } from "./runner";
import {
  appendEvent,
  bindClaim as bindClaimStore,
  finishRun,
  flushAppends,
  type StoredRun,
  type TerminalRunStatus,
} from "./store";
import { sandboxSettings } from "./sandbox";

const LEASE_TTL_MS = 60_000;
const LOCK_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const WATCHDOG_MS = 1_500;
const LOOP_FAST_MS = 100;
const LOOP_IDLE_MS = 2_000;
const STARTUP_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const GRACE_PERIOD_MS = 15_000;

/** Tunables for the worker loop; tests shrink the poll intervals. */
export interface WorkerConfig {
  leaseTtlMs: number;
  lockTtlMs: number;
  heartbeatMs: number;
  watchdogMs: number;
  loopIdleMs: number;
  loopFastMs: number;
  startupBackoffMs: number;
  maxBackoffMs: number;
  gracePeriodMs: number;
}

const DEFAULT_CONFIG: WorkerConfig = {
  leaseTtlMs: LEASE_TTL_MS,
  lockTtlMs: LOCK_TTL_MS,
  heartbeatMs: HEARTBEAT_MS,
  watchdogMs: WATCHDOG_MS,
  loopIdleMs: LOOP_IDLE_MS,
  loopFastMs: LOOP_FAST_MS,
  startupBackoffMs: STARTUP_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  gracePeriodMs: GRACE_PERIOD_MS,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(error: unknown): void {
  console.error("[buildx-worker]", error);
}

const workerState = globalThis as unknown as {
  __BUILDX_WORKER_STOPPED__?: boolean;
};

/**
 * Identity of the workspace a run mutates, used as the workspace-lock key.
 * Box mode gives every run of a user the same persistent workspace (one box
 * per user), so the user's runs contend on a single lock — that is what keeps
 * two instances from mutating the same persistent VM at once. Local mode gives
 * each run its own scratch directory, so locks are per-run.
 */
export function workspaceIdentityFor(
  run: Pick<StoredRun, "id" | "userId">,
): string {
  try {
    if (sandboxSettings().kind === "box") return `user:${run.userId}`;
  } catch {
    // Sandbox not configured (read-only tooling): fall back to the per-run key
    // rather than failing the lock acquisition.
  }
  return `run:${run.id}`;
}

/**
 * Every operation the worker performs against the engine, injectable so tests
 * can exercise the loop without a live Postgres or model provider.
 */
export interface WorkerDeps {
  db: Db;
  claimNextQueuedRun: typeof claimNextQueuedRun;
  recoverTimedOutRuns: typeof recoverTimedOutRuns;
  readRunControl: typeof readRunControl;
  heartbeatRun: typeof heartbeatRun;
  acquireWorkspaceLock: typeof acquireWorkspaceLock;
  renewWorkspaceLock: typeof renewWorkspaceLock;
  releaseRunLease: typeof releaseRunLease;
  releaseWorkspaceLock: typeof releaseWorkspaceLock;
  requeueRun: typeof requeueRun;
  bindClaim: typeof bindClaimStore;
  appendEvent: typeof appendEvent;
  flushAppends: typeof flushAppends;
  finishRun: typeof finishRun;
  startRun: typeof startRun;
  workspaceIdentityFor: (run: Pick<StoredRun, "id" | "userId">) => string;
  /** Interval/backoff overrides (defaults are production-tuned). */
  config?: Partial<WorkerConfig>;
}

function configOf(deps: WorkerDeps): WorkerConfig {
  const merged = deps.config ? { ...DEFAULT_CONFIG, ...deps.config } : DEFAULT_CONFIG;
  // Bounded grace period: never exceed half the lease TTL
  const boundedGrace = Math.min(merged.gracePeriodMs, Math.max(10, Math.floor(merged.leaseTtlMs / 2)));
  return { ...merged, gracePeriodMs: boundedGrace };
}

export function defaultDeps(): WorkerDeps {
  return {
    db: getDb(),
    claimNextQueuedRun,
    recoverTimedOutRuns,
    readRunControl,
    heartbeatRun,
    acquireWorkspaceLock,
    renewWorkspaceLock,
    releaseRunLease,
    releaseWorkspaceLock,
    requeueRun,
    bindClaim: bindClaimStore,
    appendEvent,
    flushAppends,
    finishRun,
    startRun,
    workspaceIdentityFor,
  };
}

/**
 * Claim the oldest queued run this worker can execute (respecting the
 * per-user single-running invariant and the workspace lock), execute it under
 * a renewable lease, and clean up after it. Returns `true` when a run was
 * processed so the loop can poll again promptly.
 */
export async function processNextRun(deps: WorkerDeps): Promise<boolean> {
  const cfg = configOf(deps);
  await deps
    .recoverTimedOutRuns(deps.db)
    .then((recovered) => {
      if (recovered > 0) {
        console.log(`[buildx-worker] recovered ${recovered} stalled run(s)`);
      }
    })
    .catch((error) => console.error("[buildx-worker] recovery failed", error));

  const leaseId = randomUUID();
  const claimed = await deps.claimNextQueuedRun(deps.db, {
    leaseId,
    leaseTtlMs: cfg.leaseTtlMs,
  });
  if (!claimed) return false;

  // The claim is the authoritative durable state. Rebind the (possibly cached)
  // run object to it so every append/persist/finalize carries THIS lease, never
  // a stale one from an earlier snapshot or an old claim in this VM.
  const run = await deps.bindClaim(claimed).catch((error) => {
    console.error(`[buildx-worker] failed to bind claim for ${claimed.id}`, error);
    return undefined;
  });
  if (!run) {
    await deps.requeueRun(deps.db, { runId: claimed.id, leaseId }).catch(log);
    await deps.releaseRunLease(deps.db, { runId: claimed.id, leaseId }).catch(log);
    return false;
  }

  const session = await acquireSession(deps, run, leaseId);
  if (!session) return false; // workspace busy or worker stopped; retry later

  try {
    const state = await deps.readRunControl(deps.db, {
      runId: run.id,
      leaseId,
      fencingToken: run.fencingToken,
    });
    if (state.cancelled) {
      await finalizeEarly(
        deps,
        run,
        state.reason ?? "stopped before the agent started",
      );
      return true;
    }

    await deps.startRun(run);

    // `startRun` can return without a terminal transition only when its
    // early-abort guard fired. If the lease was lost mid-run, the reclaiming
    // worker owns the row — refuse to finalize as a stale owner. Otherwise
    // answer the persisted cancel flag so the lease never silently expires.
    if (!isTerminalStatus(run.status)) {
      if (
        run.runtime.lostOwnership ||
        (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
      ) {
        run.runtime.lostOwnership = true;
        console.warn(
          `[buildx-worker] run ${run.id} lost its lease during execution; not finalizing`,
        );
      } else {
        const control = await deps.readRunControl(deps.db, {
          runId: run.id,
          leaseId,
          fencingToken: run.fencingToken,
        });
        if (control.ownsLease) {
          await finalizeEarly(
            deps,
            run,
            control.reason ??
              (control.cancelled
                ? "stopped before the agent started"
                : "the worker lost the run"),
            control.cancelled ? "cancelled" : "failed",
          );
        } else {
          run.runtime.lostOwnership = true;
          console.warn(
            `[buildx-worker] run ${run.id} lost lease check after execution; not finalizing`,
          );
        }
      }
    }
    return true;
  } finally {
    await session.release();
  }
}

interface RunSession {
  release: () => Promise<void>;
}

/**
 * Take the workspace lock and start the lease keep-alive + control-plane
 * watchdog (cancellation/ownership polling). Returns `undefined` when the
 * workspace is busy or the worker was asked to stop — the run is requeued
 * back to 'queued' state and retried on a later loop.
 */
async function acquireSession(
  deps: WorkerDeps,
  run: StoredRun,
  leaseId: string,
): Promise<RunSession | undefined> {
  const cfg = configOf(deps);
  if (workerState.__BUILDX_WORKER_STOPPED__) {
    await deps.requeueRun(deps.db, { runId: run.id, leaseId }).catch(log);
    await deps.releaseRunLease(deps.db, { runId: run.id, leaseId }).catch(log);
    return undefined;
  }

  const workspaceId = deps.workspaceIdentityFor(run);
  const lockOk = await deps
    .acquireWorkspaceLock(deps.db, { workspaceId, leaseId, ttlMs: cfg.lockTtlMs })
    .catch(() => false);
  if (!lockOk) {
    // P1: Correct workspace-lock contention handling.
    // Transition the run back to a claimable queued state using guarded requeueRun.
    await deps.requeueRun(deps.db, { runId: run.id, leaseId }).catch(log);
    await deps.releaseRunLease(deps.db, { runId: run.id, leaseId }).catch(log);
    return undefined;
  }

  let fenced = false;
  let lastConfirmedAt = Date.now();
  const timers: Array<NodeJS.Timeout> = [];

  /** Fence every persistent write and stop the in-flight agent loop. Safe to
   *  call more than once (only the first fences). */
  const fenceLostOwnership = (reason: string): void => {
    if (fenced) return;
    // The lease is also released as part of a terminal transition. A watchdog
    // tick that lands in that window is not a lost lease — the run is already
    // done, so logging/fencing would be a false alarm.
    if (isTerminalStatus(run.status)) return;
    fenced = true;
    for (const timer of timers) clearInterval(timer);
    console.warn(`[buildx-worker] fenced run ${run.id}: ${reason}`);
    run.runtime.lostOwnership = true;
    if (!run.runtime.controller.signal.aborted) {
      run.runtime.controller.abort();
    }
  };

  const handleUncertainty = (error: unknown, operation: string): void => {
    const elapsed = Date.now() - lastConfirmedAt;
    console.error(
      `[buildx-worker] ${operation} error (${elapsed}ms since last confirmation)`,
      error,
    );
    if (elapsed > cfg.gracePeriodMs) {
      fenceLostOwnership(
        `ownership unconfirmed for ${elapsed}ms (grace period ${cfg.gracePeriodMs}ms exceeded): ${String(error)}`,
      );
    }
  };

  // Lease + workspace-lock renewal. A heartbeat DB error is an *uncertain*
  // lease state: bounded grace period prevents indefinite execution during DB outages.
  const keepalive = setInterval(() => {
    void (async () => {
      try {
        const stillOurs = await deps.heartbeatRun(deps.db, {
          runId: run.id,
          leaseId,
          leaseTtlMs: cfg.leaseTtlMs,
          fencingToken: run.fencingToken,
        });
        if (!stillOurs) {
          fenceLostOwnership("lease expired or superseded by another worker");
          return;
        }
        run.leaseExpiresAt = Date.now() + cfg.leaseTtlMs;
        lastConfirmedAt = Date.now();
      } catch (error) {
        handleUncertainty(error, "heartbeat");
        return;
      }
      try {
        const kept = await deps.renewWorkspaceLock(deps.db, {
          workspaceId,
          leaseId,
          ttlMs: cfg.lockTtlMs,
        });
        if (!kept) {
          fenceLostOwnership("workspace lock stolen or expired");
          return;
        }
        lastConfirmedAt = Date.now();
      } catch (error) {
        handleUncertainty(error, "renewWorkspaceLock");
      }
    })();
  }, cfg.heartbeatMs);
  timers.push(keepalive);

  // Cancellation + ownership watchdog: polls frequently so `/stop` is honored
  // promptly, and fences the moment another instance takes the lease or cancels.
  const watchdog = setInterval(() => {
    void deps
      .readRunControl(deps.db, {
        runId: run.id,
        leaseId,
        fencingToken: run.fencingToken,
      })
      .then((control) => {
        if (!control.ownsLease) {
          fenceLostOwnership("lease taken over by another instance or expired");
          return;
        }
        lastConfirmedAt = Date.now();
        if (control.cancelled && !run.runtime.controller.signal.aborted) {
          // The agent loop stops; runner/worker finalize the run as cancelled.
          run.runtime.controller.abort();
        }
      })
      .catch((error) => {
        handleUncertainty(error, "watchdog");
      });
  }, cfg.watchdogMs);
  timers.push(watchdog);

  return {
    async release() {
      for (const timer of timers) clearInterval(timer);
      // Both releases are lease-guarded: in PostgreSQL they match `WHERE lease_id = leaseId`,
      // so they safely no-op against a lease/lock that was already reclaimed by another worker.
      await deps.releaseWorkspaceLock(deps.db, { workspaceId, leaseId }).catch(log);
      await deps.releaseRunLease(deps.db, { runId: run.id, leaseId }).catch(log);
    },
  };
}

/** Append the terminal status event, flush, and run the guarded finalize. */
async function finalizeEarly(
  deps: WorkerDeps,
  run: StoredRun,
  message: string,
  status: TerminalRunStatus = "cancelled",
): Promise<void> {
  try {
    if (
      run.runtime.lostOwnership ||
      (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
    ) {
      console.warn(`[buildx-worker] skipping finalize for fenced/expired run ${run.id}`);
      return;
    }
    await deps.appendEvent(run, {
      type: "status",
      data: { status, message },
      ts: Date.now(),
    });
    await deps.flushAppends(run.id);
    await deps.finishRun(run, status, message);
  } catch (error) {
    console.error("[buildx-worker] finalize failed", error);
  }
}

/**
 * Durable job worker: claims leases, heartbeats them, executes runs detached
 * from the request that created them, and recovers stalled work. Runs one loop
 * per process until `stopWorker()`; the loop never rejects. A transient
 * database outage at startup (or mid-loop) is retried with bounded exponential
 * backoff instead of permanently disabling the worker.
 */
export async function runWorker(
  options: { signal?: AbortSignal; deps?: WorkerDeps } = {},
): Promise<void> {
  const deps = options.deps ?? defaultDeps();
  const cfg = configOf(deps);
  const signal = options.signal;
  const shouldRun = (): boolean =>
    !workerState.__BUILDX_WORKER_STOPPED__ && !signal?.aborted;

  if (!shouldRun()) return;

  // Startup connectivity gate: there is no "execute with no queue" fallback, so
  // simply retry with backoff until the database is reachable.
  let backoffMs = cfg.startupBackoffMs;
  for (;;) {
    if (!shouldRun()) return;
    try {
      await deps.db.execute(sql`SELECT 1`);
      break;
    } catch (error) {
      console.error(
        `[buildx-worker] database unavailable; retrying in ${backoffMs}ms`,
        error,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, cfg.maxBackoffMs);
    }
  }

  while (shouldRun()) {
    try {
      const processed = await processNextRun(deps);
      backoffMs = cfg.startupBackoffMs; // any completed iteration resets backoff
      await sleep(processed ? cfg.loopFastMs : cfg.loopIdleMs);
    } catch (error) {
      console.error(
        `[buildx-worker] loop iteration failed; retrying in ${backoffMs}ms`,
        error,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, cfg.maxBackoffMs);
    }
  }
}

/** Signal the worker loop to stop after the current iteration. */
export function stopWorker(): void {
  workerState.__BUILDX_WORKER_STOPPED__ = true;
}

export function isWorkerStopped(): boolean {
  return Boolean(workerState.__BUILDX_WORKER_STOPPED__);
}

/** Clear the stopped flag so the loop can start again (tests / HMR). */
export function resetWorkerForTest(): void {
  delete workerState.__BUILDX_WORKER_STOPPED__;
}