import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { outbox, type OutboxStatus } from "./schema";

export interface OutboxPayload {
  runId: string;
  userId: string;
  task?: string | null;
  model?: string | null;
  maxSteps?: number;
  idempotencyKey?: string | null;
  step?: number;
}

export interface InsertOutboxInput {
  runId: string;
  eventType?: string;
  payload: OutboxPayload;
}

export type OutboxRow = typeof outbox.$inferSelect;

/**
 * Insert an outbox record inside an active database transaction.
 * Must be executed alongside the run creation and quota reservation.
 */
export async function insertOutboxMessage(
  tx: Db,
  input: InsertOutboxInput,
): Promise<OutboxRow> {
  const rows = await tx
    .insert(outbox)
    .values({
      runId: input.runId,
      eventType: input.eventType ?? "run_dispatched",
      payload: input.payload,
      status: "pending",
      retryCount: 0,
      createdAt: new Date(),
    })
    .returning();
  return rows[0];
}

/** Mark an outbox message as successfully published to the queue. */
export async function markOutboxPublished(
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({
      status: "published",
      publishedAt: sql`now()`,
      lastError: null,
    })
    .where(eq(outbox.id, id))
    .returning({ id: outbox.id });
  return rows.length === 1;
}

/** Record a publish failure and increment the retry counter. */
export async function recordOutboxPublishFailure(
  db: Db,
  input: { id: string; error: string; maxRetries?: number },
): Promise<{ status: OutboxStatus; retryCount: number }> {
  const maxRetries = input.maxRetries ?? 5;
  const rows = await db
    .update(outbox)
    .set({
      retryCount: sql`${outbox.retryCount} + 1`,
      lastError: input.error.slice(0, 1000),
      status: sql`CASE WHEN ${outbox.retryCount} + 1 >= ${maxRetries} THEN 'failed'::text ELSE 'pending'::text END`,
    })
    .where(eq(outbox.id, input.id))
    .returning({ status: outbox.status, retryCount: outbox.retryCount });
  return (
    rows[0] ?? {
      status: "failed",
      retryCount: maxRetries,
    }
  );
}

export interface FetchPendingOutboxOptions {
  limit?: number;
  minAgeSeconds?: number;
  maxRetries?: number;
}

/**
 * Fetch pending outbox rows that have not yet been published to the queue.
 * Filters by age (to give immediate publish attempts a chance to succeed without race)
 * and excludes messages exceeding `maxRetries`.
 */
export async function fetchPendingOutboxMessages(
  db: Db,
  options: FetchPendingOutboxOptions = {},
): Promise<OutboxRow[]> {
  const limit = options.limit ?? 20;
  const minAgeSeconds = options.minAgeSeconds ?? 5;
  const maxRetries = options.maxRetries ?? 5;

  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);

  return db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.status, "pending"),
        lte(outbox.createdAt, cutoff),
        sql`${outbox.retryCount} < ${maxRetries}`,
      ),
    )
    .orderBy(outbox.createdAt)
    .limit(limit);
}

export interface QueuePublisher {
  send(message: {
    runId: string;
    idempotencyKey?: string | null;
    step?: number;
    outboxId?: string;
  }): Promise<void>;
}

/**
 * Reconcile unpublished outbox messages by publishing them to the queue.
 * Returns the count of messages successfully published.
 */
export async function reconcileOutbox(
  db: Db,
  publisher: QueuePublisher,
  options: FetchPendingOutboxOptions = {},
): Promise<{ published: number; failed: number }> {
  const pending = await fetchPendingOutboxMessages(db, options);
  let published = 0;
  let failed = 0;

  for (const item of pending) {
    const payload = item.payload as OutboxPayload;
    try {
      await publisher.send({
        runId: item.runId,
        idempotencyKey: payload.idempotencyKey,
        step: payload.step ?? 0,
        outboxId: item.id,
      });
      await markOutboxPublished(db, item.id);
      published++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordOutboxPublishFailure(db, {
        id: item.id,
        error: message,
        maxRetries: options.maxRetries,
      });
      failed++;
    }
  }

  return { published, failed };
}
