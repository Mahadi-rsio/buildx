import { randomUUID } from "node:crypto";
import {
  DAILY_REQUEST_LIMIT,
  MONTHLY_CPU_HOURS,
  and,
  consumeDailyRequest,
  dailyRequestCount,
  dhakaDay,
  eq,
  getDb,
  monthlyCpuSecondsUsed,
  nextDhakaReset,
  runs as runsTable,
  type Db,
} from "@buildx/db";
import type { WorkspaceUsage } from "./types";
import {
  getRunForIdempotencyKey,
  hydrateRun,
  type StoredRun,
} from "./store";

/**
 * Create a run for a user with idempotent + quota-safe atomic semantics:
 *
 * 1. A repeat submit with the same `idempotencyKey` replays the original run
 *    and never consumes another quota slot.
 * 2. A day that is already at its hard limit is rejected *before* any row is
 *    created.
 * 3. Quota reservation and run creation are executed atomically inside a single
 *    database transaction.
 * 4. The run is created as `queued`; the in-process worker claims and executes it.
 */
export type CreateRunResult =
  | { kind: "created"; run: StoredRun }
  | { kind: "replayed"; run: StoredRun }
  | { kind: "quota_exhausted" };

export interface CreateRunInput {
  user: { id: string; name?: string | null; email: string };
  task: string;
  model: string;
  maxSteps: number;
  idempotencyKey?: string;
  correlationId?: string;
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

/**
 * Create (or replay) a run for a user.
 *
 * The run is created in `queued` status and will be claimed and executed by the
 * in-process worker loop (instrumentation.ts).
 */
export async function createRunForUser(
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const db = input.db ?? getDb();
  const day = dhakaDay();
  const correlationId = input.correlationId ?? randomUUID();

  // Fast-path replay check outside transaction
  if (input.idempotencyKey) {
    const existing = await getRunForIdempotencyKey(
      input.user.id,
      input.idempotencyKey,
      { db },
    );
    if (existing) {
      existing.runtime.workspace.usage = await usageFor(db, input.user.id);
      return { kind: "replayed", run: existing };
    }
  }

  // Pre-check: hard daily ceiling — never queue into an already-full day.
  const used = await dailyRequestCount(db, input.user.id, day);
  if (used >= DAILY_REQUEST_LIMIT) return { kind: "quota_exhausted" };

  const runInTx = async <T>(
    database: Db,
    fn: (tx: Db) => Promise<T>,
  ): Promise<T> => {
    // The neon-http driver does not support multi-statement transactions and
    // throws "No transactions support in neon-http driver". Execute directly.
    if (database.constructor?.name === "NeonHttpDatabase") {
      return fn(database);
    }
    const db_ = database as Db & { transaction?: (fn: (tx: Db) => Promise<T>) => Promise<T> };
    if (typeof db_.transaction === "function") {
      try {
        return await db_.transaction(fn);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("No transactions support in neon-http driver")
        ) {
          return fn(database);
        }
        throw err;
      }
    }
    return fn(database);
  };

  try {
    const result = await runInTx(db, async (tx) => {
      // Re-check idempotency inside the transaction
      if (input.idempotencyKey) {
        const [existingRow] = await tx
          .select()
          .from(runsTable)
          .where(
            and(
              eq(runsTable.userId, input.user.id),
              eq(runsTable.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existingRow) {
          return { kind: "replayed" as const, row: existingRow };
        }
      }

      // Atomically reserve a quota slot inside the transaction
      const count = await consumeDailyRequest(tx, input.user.id, day);
      if (count === null) {
        return { kind: "quota_exhausted" as const };
      }

      // Quota reservation succeeded. Now create the run row inside the same transaction
      const id = randomUUID();
      const now = new Date();
      const rows = await tx
        .insert(runsTable)
        .values({
          id,
          userId: input.user.id,
          model: input.model,
          status: "queued",
          task: input.task,
          workspaceName:
            input.user.name?.trim() ||
            input.user.email.split("@")[0] ||
            "workspace",
          maxSteps: input.maxSteps,
          idempotencyKey: input.idempotencyKey ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return { kind: "created" as const, row: rows[0] };
    });

    if (result.kind === "quota_exhausted") {
      return { kind: "quota_exhausted" };
    }

    if (result.kind === "created") {
      console.log(`[run-creation][${correlationId}] run queued: ${result.row.id}`);
    }

    const run = await hydrateRun(result.row);
    run.runtime.workspace.usage = await usageFor(db, input.user.id);
    return { kind: result.kind, run };
  } catch (error: unknown) {
    const err = (error as { cause?: unknown })?.cause;
    const target = (err && typeof err === "object" ? err : error) as {
      code?: string;
      constraint?: string;
    };
    const unique =
      target?.code === "23505" &&
      target?.constraint === "runs_idempotency_key_idx";
    if (unique && input.idempotencyKey) {
      const existing = await getRunForIdempotencyKey(
        input.user.id,
        input.idempotencyKey,
        { db },
      );
      if (existing) {
        existing.runtime.workspace.usage = await usageFor(db, input.user.id);
        return { kind: "replayed", run: existing };
      }
    }
    throw error;
  }
}