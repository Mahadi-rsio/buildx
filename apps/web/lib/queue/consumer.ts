import { randomUUID } from "node:crypto";
import {
  acquireWorkspaceLock,
  claimRunById,
  finalizeRun,
  getDb,
  readRunControl,
  releaseRunLease,
  releaseWorkspaceLock,
  requeueRun,
  runs as runsTable,
  eq,
  sql,
  type Db,
} from "@buildx/db";
import { isTerminalStatus } from "@buildx/shared";
import { startRun } from "../runner";
import {
  bindClaim as bindClaimStore,
  finishRun,
  type StoredRun,
} from "../store";
import { sandboxSettings, tryGetWorkspaceBox } from "../sandbox";
import type { RunDispatchMessage } from "./types";

export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  attempts?: number;
  ack(): void;
  retry(): void;
}

export interface QueueBatch<T = unknown> {
  queue: string;
  messages: QueueMessage<T>[];
  ackAll?(): void;
  retryAll?(): void;
}

export interface QueueConsumerDeps {
  db?: Db;
  claimRunById?: typeof claimRunById;
  startRun?: typeof startRun;
}

const LEASE_TTL_MS = 60_000;
const LOCK_TTL_MS = 60_000;
const MAX_ATTEMPTS = 3;

function workspaceIdentityFor(run: Pick<StoredRun, "id" | "userId">): string {
  try {
    if (sandboxSettings().kind === "box") return `user:${run.userId}`;
  } catch {
    // Sandbox not configured
  }
  return `run:${run.id}`;
}

/**
 * Handle remote Box cancellation decoupled from database leases.
 * Because database leases cannot automatically stop running processes in the remote VM,
 * remote Box processes are explicitly paused / terminated.
 */
export async function cancelRemoteBoxExecution(userId: string): Promise<void> {
  try {
    const box = await tryGetWorkspaceBox(userId);
    if (box) {
      await box.suspend().catch((err) => {
        console.warn(`[queue-consumer] failed to suspend box for user ${userId}`, err);
      });
    }
  } catch (error) {
    console.warn(`[queue-consumer] error cancelling remote box for user ${userId}`, error);
  }
}

/**
 * Process a single queue message idempotently.
 * Enforces atomic lease claiming, workspace locks, bounded execution, and decoupled remote Box cancellation.
 */
export async function processQueueMessage(
  msg: QueueMessage<RunDispatchMessage>,
  deps: QueueConsumerDeps = {},
): Promise<void> {
  const db = deps.db ?? getDb();
  const claimFn = deps.claimRunById ?? claimRunById;
  const startRunFn = deps.startRun ?? startRun;

  const { runId } = msg.body;
  const attempts = msg.attempts ?? 1;

  // 1. Idempotency & state check: inspect existing run in Neon
  const [existingRow] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));

  if (!existingRow) {
    console.warn(`[queue-consumer] run ${runId} not found in database; acknowledging`);
    msg.ack();
    return;
  }

  // If already terminal, acknowledge duplicate delivery and finish
  if (isTerminalStatus(existingRow.status)) {
    msg.ack();
    return;
  }

  // If cancelled before start, stop remote execution and mark terminal
  if (existingRow.cancelledAt) {
    await cancelRemoteBoxExecution(existingRow.userId);
    if (existingRow.leaseId) {
      await finalizeRun(db, {
        runId,
        leaseId: existingRow.leaseId,
        status: "cancelled",
        error: existingRow.cancelReason ?? "cancelled by user",
      }).catch(() => undefined);
    } else {
      await db
        .update(runsTable)
        .set({
          status: "cancelled",
          endedAt: sql`now()`,
          error: existingRow.cancelReason ?? "cancelled by user",
          updatedAt: sql`now()`,
        })
        .where(eq(runsTable.id, runId))
        .catch(() => undefined);
    }
    msg.ack();
    return;
  }

  // 2. Atomic lease claim for this specific run
  const leaseId = randomUUID();
  const claimedRow = await claimFn(db, {
    runId,
    leaseId,
    leaseTtlMs: LEASE_TTL_MS,
  });

  if (!claimedRow) {
    // If we couldn't claim because the user has another run active or another worker owns it:
    // Check if another worker is actively executing it
    const [current] = await db
      .select()
      .from(runsTable)
      .where(eq(runsTable.id, runId));

    if (!current || isTerminalStatus(current.status)) {
      msg.ack();
      return;
    }

    if (current.status === "running" && current.leaseId && current.leaseId !== leaseId) {
      // Another worker holds the lease. Acknowledge this duplicate message
      msg.ack();
      return;
    }

    // User is running another job or lock contention: retry with backoff if attempts < MAX_ATTEMPTS
    if (attempts >= MAX_ATTEMPTS) {
      console.error(
        `[queue-consumer] run ${runId} exceeded max attempts (${attempts}); failing`,
      );
      await finalizeRun(db, {
        runId,
        leaseId: current.leaseId ?? leaseId,
        status: "failed",
        error: "run dispatch exceeded max retry attempts due to resource contention",
      }).catch(() => undefined);
      msg.ack();
      return;
    }

    msg.retry();
    return;
  }

  // 3. Bind claim to runtime store
  const run = await bindClaimStore(claimedRow).catch((err) => {
    console.error(`[queue-consumer] failed to bind claim for run ${runId}`, err);
    return undefined;
  });

  if (!run) {
    await requeueRun(db, { runId, leaseId }).catch(() => undefined);
    await releaseRunLease(db, { runId, leaseId }).catch(() => undefined);
    msg.retry();
    return;
  }

  // 4. Acquire exclusive workspace lock
  const workspaceId = workspaceIdentityFor(run);
  const lockAcquired = await acquireWorkspaceLock(db, {
    workspaceId,
    leaseId,
    ttlMs: LOCK_TTL_MS,
  }).catch(() => false);

  if (!lockAcquired) {
    console.warn(
      `[queue-consumer] workspace ${workspaceId} busy; requeuing run ${runId}`,
    );
    await requeueRun(db, { runId, leaseId }).catch(() => undefined);
    await releaseRunLease(db, { runId, leaseId }).catch(() => undefined);
    msg.retry();
    return;
  }

  try {
    // Check control state before execution
    const control = await readRunControl(db, {
      runId,
      leaseId,
      fencingToken: run.fencingToken,
    });

    if (control.cancelled) {
      await cancelRemoteBoxExecution(run.userId);
      await finishRun(run, "cancelled", control.reason ?? "stopped by user");
      msg.ack();
      return;
    }

    if (!control.ownsLease) {
      console.warn(`[queue-consumer] lost lease before execution for run ${runId}`);
      run.runtime.lostOwnership = true;
      msg.ack();
      return;
    }

    // 5. Execute run against remote Box sandbox
    await startRunFn(run);

    // If cancellation was requested during execution
    if (run.runtime.controller.signal.aborted) {
      await cancelRemoteBoxExecution(run.userId);
    }

    msg.ack();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[queue-consumer] execution error on run ${runId}:`, error);

    // Ensure remote Box is cleaned up/suspended on error
    await cancelRemoteBoxExecution(run.userId);

    if (attempts >= MAX_ATTEMPTS) {
      await finalizeRun(db, {
        runId,
        leaseId,
        fencingToken: run.fencingToken,
        status: "failed",
        error: errorMsg,
      }).catch(() => undefined);
      msg.ack();
    } else {
      await requeueRun(db, {
        runId,
        leaseId,
        fencingToken: run.fencingToken,
      }).catch(() => undefined);
      msg.retry();
    }
  } finally {
    await releaseWorkspaceLock(db, { workspaceId, leaseId }).catch(() => undefined);
    await releaseRunLease(db, {
      runId,
      leaseId,
      fencingToken: run.fencingToken,
    }).catch(() => undefined);
  }
}

/**
 * Cloudflare Queue batch consumer handler.
 * Called when Cloudflare Queues invokes the worker with a message batch.
 */
export async function handleQueueBatch(
  batch: QueueBatch<RunDispatchMessage>,
  deps: QueueConsumerDeps = {},
): Promise<void> {
  for (const message of batch.messages) {
    await processQueueMessage(message, deps);
  }
}
