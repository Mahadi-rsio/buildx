import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { loadRootEnv } from "@buildx/shared/node";
import { getDb, type Db } from "./client";
import {
  insertOutboxMessage,
  markOutboxPublished,
  reconcileOutbox,
  recordOutboxPublishFailure,
} from "./outbox";
import { outbox, runs, user } from "./schema";

loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const createdUsers: string[] = [];
const createdRuns: string[] = [];

try {
  db = getDb({ fresh: true });
  await db.execute(sql`SELECT 1`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres unavailable: ${(error as Error).message}`;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({
    id,
    name: "Outbox Test User",
    email: `outbox-${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

async function newRun(userId: string): Promise<string> {
  const id = randomUUID();
  await db!.insert(runs).values({
    id,
    userId,
    status: "completed",
    task: "test task",
  });
  createdRuns.push(id);
  return id;
}

after(async () => {
  if (!db || skipReason) return;
  if (createdRuns.length > 0) {
    await db.delete(outbox).where(inArray(outbox.runId, createdRuns));
    await db.delete(runs).where(inArray(runs.id, createdRuns));
  }
  if (createdUsers.length > 0) {
    await db.delete(user).where(inArray(user.id, createdUsers));
  }
});

test("outbox: insert, fetch, mark published", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await newRun(userId);

  const msg = await insertOutboxMessage(db!, {
    runId,
    payload: {
      runId,
      userId,
      task: "test",
      model: "gpt-4o",
      maxSteps: 10,
    },
  });

  assert.equal(msg.runId, runId);
  assert.equal(msg.status, "pending");
  assert.equal(msg.retryCount, 0);

  // Mark published
  const ok = await markOutboxPublished(db!, msg.id);
  assert.equal(ok, true);

  const [row] = await db!
    .select()
    .from(outbox)
    .where(eq(outbox.id, msg.id));
  assert.equal(row.status, "published");
  assert.ok(row.publishedAt);
});

test("outbox: record failure and bound retries", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await newRun(userId);

  const msg = await insertOutboxMessage(db!, {
    runId,
    payload: { runId, userId },
  });

  const res1 = await recordOutboxPublishFailure(db!, {
    id: msg.id,
    error: "Queue connection timeout",
    maxRetries: 3,
  });
  assert.equal(res1.status, "pending");
  assert.equal(res1.retryCount, 1);

  const res2 = await recordOutboxPublishFailure(db!, {
    id: msg.id,
    error: "Queue connection timeout 2",
    maxRetries: 3,
  });
  assert.equal(res2.status, "pending");
  assert.equal(res2.retryCount, 2);

  const res3 = await recordOutboxPublishFailure(db!, {
    id: msg.id,
    error: "Queue connection timeout 3",
    maxRetries: 3,
  });
  assert.equal(res3.status, "failed");
  assert.equal(res3.retryCount, 3);
});

test("outbox: reconciliation dispatches unpublished messages", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await newRun(userId);

  const msg = await insertOutboxMessage(db!, {
    runId,
    payload: { runId, userId, task: "reconcile task" },
  });

  // Force createdAt to be older than 5s so it qualifies as pending
  await db!
    .update(outbox)
    .set({ createdAt: new Date(Date.now() - 10_000) })
    .where(eq(outbox.id, msg.id));

  const dispatched: Array<{ runId: string }> = [];
  const fakePublisher = {
    async send(message: { runId: string }) {
      dispatched.push(message);
    },
  };

  const result = await reconcileOutbox(db!, fakePublisher, { minAgeSeconds: 2 });
  assert.ok(result.published >= 1);
  assert.ok(dispatched.some((d) => d.runId === runId));

  const [updated] = await db!
    .select()
    .from(outbox)
    .where(eq(outbox.id, msg.id));
  assert.equal(updated.status, "published");
});
