import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  claimNextQueuedRun,
  eq,
  finalizeRun,
  getDb,
  inArray,
  readRunControl,
  runs as runsTable,
  sql,
  user,
  type Db,
  type RunRow,
} from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import {
  appendEvent,
  bindClaim,
  cancelRun,
  createRun,
  StaleRunError,
} from "./store";
import { processQueueMessage } from "./queue/consumer";

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
    name: "Cancellation Test User",
    email: `cancel-${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

after(async () => {
  if (!db || skipReason) return;
  if (createdRuns.length > 0) {
    await db.delete(runsTable).where(inArray(runsTable.id, createdRuns)).catch(() => undefined);
  }
  if (createdUsers.length > 0) {
    await db.delete(user).where(inArray(user.id, createdUsers)).catch(() => undefined);
  }
});

test("cancellation regression: Stop after completion is rejected and preserves completed status", { skip: skipReason }, async () => {
  const userId = await newUser();
  const { run } = await createRun({
    userId,
    workspaceName: "complete-then-stop",
    task: "test complete then stop",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  createdRuns.push(run.id);

  // Complete the run directly in Neon
  await db!
    .update(runsTable)
    .set({
      status: "completed",
      endedAt: new Date(),
    })
    .where(eq(runsTable.id, run.id));

  run.status = "completed";

  // Request cancellation on the completed run
  const result = await cancelRun(run, "stop after complete");
  assert.equal(result, false, "cancelRun must return false for completed run");

  // Verify status in Neon DB is still completed
  const [row] = await db!.select().from(runsTable).where(eq(runsTable.id, run.id));
  assert.equal(row.status, "completed");
  assert.equal(row.cancelledAt, null, "cancelledAt must remain null for completed run");
});

test("cancellation regression: repeated Stop requests are idempotent", { skip: skipReason }, async () => {
  const userId = await newUser();
  const { run } = await createRun({
    userId,
    workspaceName: "repeated-stop",
    task: "test repeated stop",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  createdRuns.push(run.id);

  // First cancellation on queued run
  const first = await cancelRun(run, "user stopped");
  assert.equal(first, true, "First cancellation request must succeed");

  const [row1] = await db!.select().from(runsTable).where(eq(runsTable.id, run.id));
  assert.equal(row1.status, "cancelled");
  assert.ok(row1.cancelledAt !== null);

  // Second cancellation on already cancelled run
  const second = await cancelRun(run, "user stopped again");
  assert.equal(second, false, "Second cancellation request must be idempotent and return false");

  // Re-check row in Neon DB
  const [row2] = await db!.select().from(runsTable).where(eq(runsTable.id, run.id));
  assert.equal(row2.status, "cancelled");
  assert.equal(row2.cancelledAt?.getTime(), row1.cancelledAt?.getTime());
});

test("cancellation regression: cancelled runs do not restart or transition back to running", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = randomUUID();
  createdRuns.push(runId);

  // Insert a cancelled run in Neon
  await db!.insert(runsTable).values({
    id: runId,
    userId,
    status: "cancelled",
    task: "do not restart",
    cancelledAt: new Date(),
    cancelReason: "stopped",
    endedAt: new Date(),
  });

  // 1. claimNextQueuedRun must not pick up this cancelled run
  const claimed = await claimNextQueuedRun(db!, {
    leaseId: "worker-claim-test",
    leaseTtlMs: 30_000,
  });
  if (claimed) {
    assert.notEqual(claimed.id, runId, "claimNextQueuedRun must never claim a cancelled run");
  }

  // 2. Queue consumer processing duplicate message must acknowledge and NOT start run
  let startRunCalled = false;
  let ackCalled = false;
  const fakeMessage = {
    id: "msg-cancelled-run",
    body: { runId },
    ack() {
      ackCalled = true;
    },
    retry() {},
  };

  await processQueueMessage(fakeMessage, {
    db: db!,
    startRun: async () => {
      startRunCalled = true;
    },
  });

  assert.equal(ackCalled, true, "Queue message for cancelled run must be acknowledged");
  assert.equal(startRunCalled, false, "Execution must NOT be started for cancelled run");

  // 3. Neon DB rejects finalizing as completed
  const finalizeOk = await finalizeRun(db!, {
    runId,
    leaseId: "stale-lease",
    status: "completed",
  });
  assert.equal(finalizeOk, false, "Neon DB must reject finalizing a cancelled run as completed");

  // 4. Verify status in DB remained cancelled
  const [row] = await db!.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(row.status, "cancelled");
});

test("cancellation regression: late progress events and tool writes rejected after cancellation", { skip: skipReason }, async () => {
  const userId = await newUser();
  const { run } = await createRun({
    userId,
    workspaceName: "late-writes-guard",
    task: "test late writes guard",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  createdRuns.push(run.id);

  // Set running with active lease
  const [claimedRow] = await db!
    .update(runsTable)
    .set({
      status: "running",
      leaseId: "active-lease-123",
      fencingToken: 1,
      leaseExpiresAt: sql`now() + interval '60 seconds'`,
      startedAt: new Date(),
    })
    .where(eq(runsTable.id, run.id))
    .returning();

  const worker = await bindClaim(claimedRow as RunRow);

  // Append initial progress event before cancellation (must succeed)
  const ev1 = await appendEvent(worker, {
    type: "text",
    data: { text: "before cancel" },
    ts: Date.now(),
  });
  assert.ok(ev1.id > 0);

  // Request cancellation in Neon DB
  await cancelRun(worker, "stop requested by user");

  // Reset local controller to simulate a different worker/isolate attempting late writes
  worker.runtime.controller = new AbortController();
  worker.runtime.lostOwnership = false;

  // Late progress events must be rejected by Postgres appendGuardedEvent
  await assert.rejects(
    appendEvent(worker, {
      type: "text",
      data: { text: "late text after cancel" },
      ts: Date.now(),
    }),
    StaleRunError,
    "Late progress events must be rejected with StaleRunError",
  );

  // Verify run control flags
  const ctrl = await readRunControl(db!, {
    runId: run.id,
    leaseId: "active-lease-123",
    fencingToken: 1,
  });
  assert.equal(ctrl.cancelled, true, "readRunControl must report cancelled=true");
});
