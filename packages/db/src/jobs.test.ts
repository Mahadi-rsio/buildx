import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { loadRootEnv } from "@buildx/shared/node";
import { getDb, type Db } from "./client";
import {
  acquireWorkspaceLock,
  claimNextQueuedRun,
  finalizeRun,
  heartbeatRun,
  isRunCancelled,
  readRunControl,
  recoverTimedOutRuns,
  releaseRunLease,
  releaseWorkspaceLock,
  renewWorkspaceLock,
  requestCancellation,
} from "./jobs";
import { runs, user } from "./schema";

/** Real-Postgres tests; skip when the database is unreachable. */
loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const createdUsers: string[] = [];

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
    name: "Job Test",
    email: `jobs-${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

async function insertRun(
  userId: string,
  fields?: Partial<typeof runs.$inferInsert>,
): Promise<string> {
  const createdAt = fields?.createdAt ?? new Date(Date.now());
  const [row] = await db!
    .insert(runs)
    .values({ userId, status: "queued", model: "test", ...fields, createdAt })
    .returning({ id: runs.id });
  return row.id;
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("claim picks the oldest queued run and leases it", { skip: skipReason }, async () => {
  const userId = await newUser();
  const older = await insertRun(userId, { createdAt: new Date(Date.now() - 5000) });
  const newer = await insertRun(userId, { createdAt: new Date() });

  const claimed = await claimNextQueuedRun(db!, { leaseId: "lease-1" });
  assert.ok(claimed);
  assert.equal(claimed.id, older);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.leaseId, "lease-1");
  assert.ok(claimed.leaseExpiresAt);
  assert.ok(claimed.startedAt);

  const [rest] = await db!.select().from(runs).where(eq(runs.id, newer));
  assert.equal(rest.status, "queued");
});

test("claim skips users who already have a running run", { skip: skipReason }, async () => {
  const busyUser = await newUser();
  const freeUser = await newUser();
  const busyQueued = await insertRun(busyUser, { createdAt: new Date(Date.now() - 10_000) });
  const freeQueued = await insertRun(freeUser, { createdAt: new Date() });

  const first = await claimNextQueuedRun(db!, { leaseId: "lease-busy" });
  assert.ok(first);
  assert.equal(first.id, busyQueued);

  const second = await claimNextQueuedRun(db!, { leaseId: "lease-free" });
  assert.ok(second);
  assert.equal(second.id, freeQueued);

  const third = await claimNextQueuedRun(db!, { leaseId: "lease-none" });
  assert.equal(third, null);
});

test("heartbeat and release only succeed while we own the lease", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await insertRun(userId);

  const claimed = await claimNextQueuedRun(db!, { leaseId: "lease-heartbeat" });
  assert.equal(claimed?.id, runId);

  assert.equal(await heartbeatRun(db!, { runId, leaseId: "lease-heartbeat" }), true);
  assert.equal(await heartbeatRun(db!, { runId, leaseId: "wrong-lease" }), false);

  assert.equal(await releaseRunLease(db!, { runId, leaseId: "lease-heartbeat" }), true);
  assert.equal(await heartbeatRun(db!, { runId, leaseId: "lease-heartbeat" }), false);
});

test("finalizeRun requires lease ownership and honors cancel state", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await insertRun(userId);
  await claimNextQueuedRun(db!, { leaseId: "lease-finalize" });

  // Wrong lease: refused.
  assert.equal(
    await finalizeRun(db!, { runId, leaseId: "wrong", status: "completed" }),
    false,
  );
  // Right lease, uncancelled run: completed wins.
  assert.equal(
    await finalizeRun(db!, { runId, leaseId: "lease-finalize", status: "completed" }),
    true,
  );
  // Terminal: further transitions refused.
  assert.equal(
    await finalizeRun(db!, { runId, leaseId: "lease-finalize", status: "failed", error: "x" }),
    false,
  );
});

test("cancel flow: request, observe, finalize as cancelled; completed refused", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await insertRun(userId);
  await claimNextQueuedRun(db!, { leaseId: "lease-cancel" });

  assert.equal(await requestCancellation(db!, { runId, reason: "user asked" }), true);
  assert.deepEqual(await isRunCancelled(db!, runId), {
    cancelled: true,
    reason: "user asked",
  });
  assert.equal(await requestCancellation(db!, { runId }), false);

  // Cancelled run must NOT finalize as completed.
  assert.equal(
    await finalizeRun(db!, { runId, leaseId: "lease-cancel", status: "completed" }),
    false,
  );
  assert.equal(
    await finalizeRun(db!, { runId, leaseId: "lease-cancel", status: "cancelled" }),
    true,
  );
});

test("readRunControl reports cancellation and lease ownership in one read", { skip: skipReason }, async () => {
  const userId = await newUser();
  const runId = await insertRun(userId);

  // Queued (unclaimed): not ours, not cancelled.
  assert.deepEqual(await readRunControl(db!, { runId, leaseId: "lease-me" }), {
    cancelled: false,
    reason: null,
    ownsLease: false,
  });

  await claimNextQueuedRun(db!, { leaseId: "lease-me" });
  assert.deepEqual(await readRunControl(db!, { runId, leaseId: "lease-me" }), {
    cancelled: false,
    reason: null,
    ownsLease: true,
  });
  // A stale lease that no longer owns the run is surfaced as not-ours.
  assert.deepEqual(await readRunControl(db!, { runId, leaseId: "lease-stale" }), {
    cancelled: false,
    reason: null,
    ownsLease: false,
  });

  await requestCancellation(db!, { runId, reason: "stopped by the user" });
  const control = await readRunControl(db!, { runId, leaseId: "lease-me" });
  assert.equal(control.cancelled, true);
  assert.equal(control.reason, "stopped by the user");
  assert.equal(control.ownsLease, true);
  // A vanished run reads as foreign and safe-to-ignore.
  assert.deepEqual(await readRunControl(db!, { runId: randomUUID(), leaseId: "lease-gone" }), {
    cancelled: false,
    reason: null,
    ownsLease: false,
  });
});

test("recoverTimedOutRuns requeues broken leases and cancels stopped runs", { skip: skipReason }, async () => {
  const requeueUser = await newUser();
  const cancelUser = await newUser();
  const requeue = await insertRun(requeueUser, {
    status: "running",
    leaseId: "dead-1",
    leaseExpiresAt: new Date(Date.now() - 60_000),
    startedAt: new Date(Date.now() - 120_000),
  });
  const cancel = await insertRun(cancelUser, {
    status: "running",
    leaseId: "dead-2",
    leaseExpiresAt: new Date(Date.now() - 60_000),
    startedAt: new Date(Date.now() - 120_000),
    cancelledAt: new Date(),
    cancelReason: "stopped",
  });

  const recovered = await recoverTimedOutRuns(db!);
  assert.ok(recovered >= 2);

  const [a] = await db!.select().from(runs).where(eq(runs.id, requeue));
  assert.equal(a.status, "queued");
  assert.equal(a.leaseId, null);

  const [b] = await db!.select().from(runs).where(eq(runs.id, cancel));
  assert.equal(b.status, "cancelled");
});

test("workspace lock: acquire/renew/release with the right lease only", { skip: skipReason }, async () => {
  const workspaceId = randomUUID();
  assert.equal(await acquireWorkspaceLock(db!, { workspaceId, leaseId: "lock-a" }), true);
  assert.equal(await acquireWorkspaceLock(db!, { workspaceId, leaseId: "lock-b" }), false);
  assert.equal(await renewWorkspaceLock(db!, { workspaceId, leaseId: "lock-b" }), false);
  assert.equal(await renewWorkspaceLock(db!, { workspaceId, leaseId: "lock-a" }), true);
  assert.equal(await releaseWorkspaceLock(db!, { workspaceId, leaseId: "lock-b" }), false);
  assert.equal(await releaseWorkspaceLock(db!, { workspaceId, leaseId: "lock-a" }), true);
  assert.equal(await acquireWorkspaceLock(db!, { workspaceId, leaseId: "lock-b" }), true);
});

test("idempotency key is unique per user", { skip: skipReason }, async () => {
  const userId = await newUser();
  await insertRun(userId, { idempotencyKey: "dedupe-me" });

  await assert.rejects(() => insertRun(userId, { idempotencyKey: "dedupe-me" }));
  const other = await newUser();
  await insertRun(other, { idempotencyKey: "dedupe-me" });
});