import {
  DAILY_REQUEST_LIMIT,
  MONTHLY_CPU_HOURS,
  consumeDailyRequest,
  dailyRequestCount,
  dhakaDay,
  getDb,
  monthlyCpuSecondsUsed,
  nextDhakaReset,
  type Db,
} from "@buildx/db";
import type { WorkspaceUsage } from "./types";
import {
  createRun,
  getRunForIdempotencyKey,
  removeQueuedRun,
  type StoredRun,
} from "./store";

/**
 * Enqueue a run for a user with idempotent + quota-safe semantics:
 *
 * 1. A repeat submit with the same `idempotencyKey` replays the original run
 *    and never consumes another quota slot (a client retry after a dropped
 *    response isn't double-charged or duplicated).
 * 2. A day that is already at its hard limit is rejected *before* any row is
 *    created.
 * 3. The quota slot is consumed only for runs this request actually created —
 *    never for replays — and only *after* the run row exists, so a failed
 *    creation can't burn quota.
 * 4. If two requests race for the final slot, the loser's freshly queued row is
 *    rolled back rather than running in an over-limit day.
 */
export type EnqueueRunResult =
  | { kind: "created"; run: StoredRun }
  | { kind: "replayed"; run: StoredRun }
  | { kind: "quota_exhausted" };

export interface EnqueueRunInput {
  user: { id: string; name?: string | null; email: string };
  task: string;
  model: string;
  maxSteps: number;
  idempotencyKey?: string;
  /** Injectable for tests; defaults to the app's database. */
  db?: Db;
}

async function usageFor(db: Db, userId: string): Promise<WorkspaceUsage> {
  const [usedCpuSeconds, usedDaily] = await Promise.all([
    monthlyCpuSecondsUsed(db, userId),
    dailyRequestCount(db, userId),
  ]);
  return {
    cpuHoursUsed: Number((usedCpuSeconds / 3600).toFixed(2)),
    cpuHoursLimit: MONTHLY_CPU_HOURS,
    dailyRequestsUsed: usedDaily,
    dailyRequestsLimit: DAILY_REQUEST_LIMIT,
    nextDhakaResetAt: nextDhakaReset().getTime(),
  };
}

export async function enqueueRunForUser(
  input: EnqueueRunInput,
): Promise<EnqueueRunResult> {
  const db = input.db ?? getDb();
  const day = dhakaDay();

  // Replay an existing submission without consuming a quota slot.
  if (input.idempotencyKey) {
    const existing = await getRunForIdempotencyKey(
      input.user.id,
      input.idempotencyKey,
    );
    if (existing) {
      existing.runtime.workspace.usage = await usageFor(db, input.user.id);
      return { kind: "replayed", run: existing };
    }
  }

  // Hard daily ceiling — never queue into an already-full day.
  const used = await dailyRequestCount(db, input.user.id, day);
  if (used >= DAILY_REQUEST_LIMIT) return { kind: "quota_exhausted" };

  // Creates the row for us; a racing duplicate (unique-index catch) is reported
  // with `created: false` and must not consume a second slot.
  const { run, created } = await createRun(
    {
      userId: input.user.id,
      workspaceName: input.user.name?.trim() || input.user.email.split("@")[0] || "workspace",
      task: input.task,
      model: input.model,
      maxSteps: input.maxSteps,
      idempotencyKey: input.idempotencyKey,
    },
    { db },
  );

  if (!created) {
    run.runtime.workspace.usage = await usageFor(db, input.user.id);
    return { kind: "replayed", run };
  }

  // Consume the slot only now that the run exists. If a concurrent request took
  // the last slot between our check and this consume, roll the queue row back
  // so nothing executes in an over-limit day.
  const consumed = await consumeDailyRequest(db, input.user.id, day);
  if (consumed == null) {
    await removeQueuedRun(run.id).catch(() => undefined);
    return { kind: "quota_exhausted" };
  }

  run.runtime.workspace.usage = await usageFor(db, input.user.id);
  return { kind: "created", run };
}