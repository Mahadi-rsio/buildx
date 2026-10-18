import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  eq,
  getDb,
  inArray,
  insertOutboxMessage,
  outbox,
  reconcileOutbox,
  runs as runsTable,
  sql,
  user,
  type Db,
} from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import { LocalSandbox } from "@buildx/sandbox";
import { createSandbox, sandboxSettings } from "./sandbox";
import { enqueueRunForUser } from "./run-creation";
import { processQueueMessage } from "./queue/consumer";
import { getCache, setCache } from "./cloudflare/kv-cache";

loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const createdUsers: string[] = [];
const createdRuns: string[] = [];

try {
  db = getDb();
  await db.execute(sql`SELECT 1`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres unavailable: ${(error as Error).message}`;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({
    id,
    name: "CF Migration User",
    email: `cf-${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

after(async () => {
  if (!db || skipReason) return;
  if (createdRuns.length > 0) {
    await db.delete(outbox).where(inArray(outbox.runId, createdRuns)).catch(() => undefined);
    await db.delete(runsTable).where(inArray(runsTable.id, createdRuns)).catch(() => undefined);
  }
  if (createdUsers.length > 0) {
    await db.delete(user).where(inArray(user.id, createdUsers)).catch(() => undefined);
  }
});

// 1. Production sandbox selection
test("production sandbox: LocalSandbox is strictly forbidden in production", () => {
  const env = process.env as Record<string, string | undefined>;
  const origEnv = env.NODE_ENV;
  try {
    env.NODE_ENV = "production";
    delete process.env.UPSTASH_BOX_API_KEY;
    delete process.env.BUILDX_SANDBOX_KIND;

    assert.throws(
      () => new LocalSandbox({ rootDir: "/tmp/test" }),
      /LocalSandbox is strictly forbidden in production/i,
    );

    assert.throws(
      () =>
        createSandbox({
          workspaceDir: "/tmp/test",
          userId: "user-123",
          workspaceName: "ws",
        }),
      /Production execution requires Upstash Box/i,
    );
  } finally {
    env.NODE_ENV = origEnv;
  }
});

test("production sandbox: rejects explicit BUILDX_SANDBOX_KIND=local in production", () => {
  const env = process.env as Record<string, string | undefined>;
  const origEnv = env.NODE_ENV;
  const origKind = process.env.BUILDX_SANDBOX_KIND;
  try {
    env.NODE_ENV = "production";
    process.env.BUILDX_SANDBOX_KIND = "local";

    assert.throws(
      () => sandboxSettings(),
      /BUILDX_SANDBOX_KIND=local is strictly forbidden in production/i,
    );
  } finally {
    env.NODE_ENV = origEnv;
    if (origKind) process.env.BUILDX_SANDBOX_KIND = origKind;
    else delete process.env.BUILDX_SANDBOX_KIND;
  }
});

// 2. Outbox creation and atomic quota reservation
test("outbox: enqueueRunForUser atomically creates outbox row with run", { skip: skipReason }, async () => {
  const userId = await newUser();
  const res = await enqueueRunForUser({
    user: { id: userId, email: `cf-${userId}@test.local` },
    task: "test outbox queueing",
    model: "gpt-4o",
    maxSteps: 10,
    db: db!,
  });

  assert.equal(res.kind, "created");
  if (res.kind === "created") {
    createdRuns.push(res.run.id);

    const [outboxRow] = await db!
      .select()
      .from(outbox)
      .where(eq(outbox.runId, res.run.id));

    assert.ok(outboxRow, "Outbox row must exist");
    assert.equal(outboxRow.runId, res.run.id);
    assert.ok(
      ["pending", "published"].includes(outboxRow.status),
      `Expected status to be pending or published, got ${outboxRow.status}`,
    );
  }
});

// 3. Outbox recovery / reconciliation
test("outbox: reconciliation dispatches unpublished messages", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = randomUUID();
  createdRuns.push(runId);

  await db!.insert(runsTable).values({
    id: runId,
    userId,
    status: "queued",
    task: "reconcile task",
  });

  const msg = await insertOutboxMessage(db!, {
    runId,
    payload: { runId, userId, task: "reconcile task" },
  });

  // Backdate createdAt so it qualifies as stale pending message
  await db!
    .update(outbox)
    .set({ createdAt: new Date(Date.now() - 10_000) })
    .where(eq(outbox.id, msg.id));

  const sent: Array<{ runId: string }> = [];
  const fakePublisher = {
    async send(message: { runId: string }) {
      sent.push(message);
    },
  };

  const report = await reconcileOutbox(db!, fakePublisher, { minAgeSeconds: 2 });
  assert.ok(report.published >= 1);
  assert.ok(sent.some((s) => s.runId === runId));

  const [updated] = await db!
    .select()
    .from(outbox)
    .where(eq(outbox.id, msg.id));
  assert.equal(updated.status, "published");
});

// 4. Duplicate message handling and idempotency in queue consumer
test("queue consumer: handles duplicate delivery idempotently for terminal runs", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = randomUUID();
  createdRuns.push(runId);

  await db!.insert(runsTable).values({
    id: runId,
    userId,
    status: "completed",
    task: "finished run",
  });

  let ackCalled = false;
  let retryCalled = false;
  let startRunCalled = false;

  const fakeMsg = {
    id: "msg-1",
    body: { runId },
    ack() {
      ackCalled = true;
    },
    retry() {
      retryCalled = true;
    },
  };

  await processQueueMessage(fakeMsg, {
    db: db!,
    startRun: async () => {
      startRunCalled = true;
    },
  });

  assert.equal(ackCalled, true, "Terminal run message must be acknowledged");
  assert.equal(retryCalled, false);
  assert.equal(startRunCalled, false, "Execution must not run again for terminal run");
});

// 5. Decoupled remote Box cancellation
test("queue consumer: acknowledges cancelled runs without starting execution", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = randomUUID();
  createdRuns.push(runId);

  await db!.insert(runsTable).values({
    id: runId,
    userId,
    status: "queued",
    task: "cancelled run",
    cancelledAt: new Date(),
    cancelReason: "Stopped by user",
  });

  let ackCalled = false;
  let startRunCalled = false;

  const fakeMsg = {
    id: "msg-cancel",
    body: { runId },
    ack() {
      ackCalled = true;
    },
    retry() {},
  };

  await processQueueMessage(fakeMsg, {
    db: db!,
    startRun: async () => {
      startRunCalled = true;
    },
  });

  assert.equal(ackCalled, true);
  assert.equal(startRunCalled, false);

  const [row] = await db!.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(row.status, "cancelled");
});

// 6. KV cache disposable helper with TTL
test("kv-cache: stores and retrieves cache with TTL", async () => {
  await setCache("test:disposable:key", { foo: "bar" }, 120);
  const val = await getCache<{ foo: string }>("test:disposable:key");
  assert.deepEqual(val, { foo: "bar" });
});

// 7. Queue dispatch failure handling
test(
  "queue dispatch failure: updates persisted run to failed with a safe, visible error",
  { skip: skipReason },
  async () => {
    const userId = await newUser();
    const failingQueue = {
      async send() {
        throw new Error("Cloudflare Queue binding unavailable or network error");
      },
    };

    const res = await enqueueRunForUser({
      user: { id: userId, email: `cf-fail-${userId}@test.local` },
      task: "test dispatch failure task",
      model: "gpt-4o",
      maxSteps: 10,
      db: db!,
      queue: failingQueue,
    });

    assert.equal(res.kind, "created");
    if (res.kind === "created") {
      createdRuns.push(res.run.id);

      // Returned run must reflect failed status and safe error
      assert.equal(res.run.status, "failed");
      assert.equal(
        res.run.error,
        "Failed to dispatch run to execution queue",
      );

      // Persisted row in Neon must also be marked failed
      const [dbRow] = await db!
        .select()
        .from(runsTable)
        .where(eq(runsTable.id, res.run.id));
      assert.ok(dbRow);
      assert.equal(dbRow.status, "failed");
      assert.equal(
        dbRow.error,
        "Failed to dispatch run to execution queue",
      );
      assert.ok(dbRow.endedAt);

      // Outbox failure must be recorded
      const [outboxRow] = await db!
        .select()
        .from(outbox)
        .where(eq(outbox.runId, res.run.id));
      assert.ok(outboxRow);
      assert.ok(outboxRow.lastError?.includes("Cloudflare Queue binding unavailable"));
    }
  },
);

// 8. Successful end-to-end queue dispatch and consumer execution
test(
  "end-to-end queue dispatch and consumer execution: awaited publish and consumer claim",
  { skip: skipReason },
  async () => {
    const userId = await newUser();
    const dispatchedMessages: unknown[] = [];
    const testQueue = {
      async send(msg: unknown) {
        dispatchedMessages.push(msg);
      },
    };

    const res = await enqueueRunForUser({
      user: { id: userId, email: `cf-e2e-${userId}@test.local` },
      task: "Hi",
      model: "gpt-4o",
      maxSteps: 10,
      db: db!,
      queue: testQueue,
    });

    assert.equal(res.kind, "created");
    if (res.kind === "created") {
      createdRuns.push(res.run.id);

      assert.equal(res.run.status, "queued");
      assert.equal(dispatchedMessages.length, 1);

      // Outbox must be marked published immediately because publish was awaited
      const [outboxRow] = await db!
        .select()
        .from(outbox)
        .where(eq(outbox.runId, res.run.id));
      assert.ok(outboxRow);
      assert.equal(outboxRow.status, "published");
      assert.ok(outboxRow.publishedAt);

      // Consumer processes the message
      let executed = false;
      let ackCalled = false;
      const queueMsg = {
        id: "msg-e2e-1",
        body: dispatchedMessages[0] as { runId: string },
        ack() {
          ackCalled = true;
        },
        retry() {},
      };

      await processQueueMessage(queueMsg, {
        db: db!,
        startRun: async (run) => {
          executed = true;
          assert.equal(run.id, res.run.id);
        },
      });

      assert.equal(executed, true, "startRun must be called by the queue consumer");
      assert.equal(ackCalled, true, "message must be acknowledged by consumer");
    }
  },
);

