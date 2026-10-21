import { randomUUID } from "node:crypto";
import {
  MONTHLY_CPU_HOURS,
  and,
  conversations as conversationsTable,
  eq,
  getDb,
  monthlyCpuSecondsUsed,
  runs as runsTable,
  type Db,
} from "@buildx/db";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type ContextWindowTokens,
  type ConversationTurn,
} from "@buildx/shared";
import type { WorkspaceUsage } from "./types";
import {
  getRunForIdempotencyKey,
  hydrateRun,
  type StoredRun,
} from "./store";
import {
  QuotaServiceUnavailableError,
  readConfiguredQuota,
  type QuotaSnapshot,
} from "./quota";

/**
 * Create a run for a user with idempotent + quota-safe atomic semantics:
 *
 * 1. A repeat submit with the same `idempotencyKey` replays the original run
 *    and never reserves another model request.
 * 2. A day that is already at its hard limit is rejected *before* any row is
 *    created (the per-step reservation still happens right before each request).
 * 3. Quota reads fail closed when Redis is unavailable; runs are never queued
 *    without a working quota service.
 * 4. The run is created as `queued`; the in-process worker claims and executes it.
 */
export type CreateRunResult =
  | { kind: "created"; run: StoredRun }
  | { kind: "replayed"; run: StoredRun }
  | { kind: "quota_exhausted" }
  | { kind: "quota_unavailable" }
  | { kind: "conversation_conflict" };

/** Injectable quota reader so tests never touch Redis. */
export interface QuotaGate {
  read(userId: string): Promise<QuotaSnapshot>;
}

export interface CreateRunInput {
  user: { id: string; name?: string | null; email: string };
  task: string;
  model: string;
  maxSteps: number;
  contextWindowTokens?: ContextWindowTokens;
  history?: ConversationTurn[];
  skillNames?: string[];
  conversationId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  /** Injectable for tests; defaults to the app's database. */
  db?: Db;
  /** Injectable for tests; defaults to the Upstash-backed service. */
  quota?: QuotaGate;
}

function usageFor(
  cpuSeconds: number,
  quota: QuotaSnapshot,
): WorkspaceUsage {
  return {
    cpuHoursUsed: Number((cpuSeconds / 3600).toFixed(2)),
    cpuHoursLimit: MONTHLY_CPU_HOURS,
    dailyRequestsUsed: quota.used,
    dailyRequestsLimit: quota.limit,
    nextDhakaResetAt: quota.resetAt,
  };
}

async function ensureConversation(
  db: Db,
  input: { id: string; userId: string; title: string },
): Promise<"ok" | "conflict"> {
  const [inserted] = await db
    .insert(conversationsTable)
    .values({ id: input.id, userId: input.userId, title: input.title })
    .onConflictDoNothing({ target: conversationsTable.id })
    .returning({ userId: conversationsTable.userId });

  // A new conversation is owned by this user by construction; only an existing
  // row needs an ownership re-read (one fewer round trip on the common path).
  if (inserted) return inserted.userId === input.userId ? "ok" : "conflict";

  const [row] = await db
    .select({ userId: conversationsTable.userId })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, input.id));
  if (!row || row.userId !== input.userId) return "conflict";
  return "ok";
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
  const correlationId = input.correlationId ?? randomUUID();
  const quotaGate: QuotaGate = input.quota ?? {
    read: readConfiguredQuota,
  };

  const readQuota = async (): Promise<QuotaSnapshot | null> => {
    try {
      return await quotaGate.read(input.user.id);
    } catch (error) {
      if (error instanceof QuotaServiceUnavailableError) return null;
      throw error;
    }
  };

  const cpuUsage = async (): Promise<number> =>
    input.db ? 0 : monthlyCpuSecondsUsed(db, input.user.id);

  // Fast-path replay check outside the transaction.
  if (input.idempotencyKey) {
    const existing = await getRunForIdempotencyKey(
      input.user.id,
      input.idempotencyKey,
      { db },
    );
    if (existing) {
      const quota = await readQuota();
      if (!quota) return { kind: "quota_unavailable" };
      existing.runtime.workspace.usage = usageFor(await cpuUsage(), quota);
      return { kind: "replayed", run: existing };
    }
  }

  // Pre-check: hard daily ceiling — never queue into an already-full day.
  // The actual reservation is per model step inside the agent loop.
  const preflight = await readQuota();
  if (!preflight) return { kind: "quota_unavailable" };
  if (preflight.remaining <= 0) return { kind: "quota_exhausted" };

  const conversationId = input.conversationId ?? randomUUID();
  const title = input.task.slice(0, 200);
  // The CPU-usage aggregate is independent of run/conversation creation, so
  // overlap it with the writes instead of paying for it after they finish.
  const cpuUsagePromise = cpuUsage();
  const conversation = await ensureConversation(db, {
    id: conversationId,
    userId: input.user.id,
    title,
  });
  if (conversation === "conflict") return { kind: "conversation_conflict" };

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
      // Re-check idempotency inside the transaction.
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

      const id = randomUUID();
      const now = new Date();
      const rows = await tx
        .insert(runsTable)
        .values({
          id,
          userId: input.user.id,
          conversationId,
          model: input.model,
          status: "queued",
          task: input.task,
          history: input.history?.length ? input.history : null,
          skillNames: input.skillNames?.length ? input.skillNames : null,
          workspaceName:
            input.user.name?.trim() ||
            input.user.email.split("@")[0] ||
            "workspace",
          maxSteps: input.maxSteps,
          contextWindowTokens:
            input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
          idempotencyKey: input.idempotencyKey ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return { kind: "created" as const, row: rows[0] };
    });

    if (result.kind === "created") {
      console.log(`[run-creation][${correlationId}] run queued: ${result.row.id}`);
    }

    const run = await hydrateRun(result.row, {
      loadEvents: result.kind !== "created",
    });
    run.runtime.workspace.usage = usageFor(await cpuUsagePromise, preflight);
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
        const quota = await readQuota();
        if (!quota) return { kind: "quota_unavailable" };
        existing.runtime.workspace.usage = usageFor(await cpuUsage(), quota);
        return { kind: "replayed", run: existing };
      }
    }
    throw error;
  }
}
