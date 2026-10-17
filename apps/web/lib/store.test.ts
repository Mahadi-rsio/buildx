import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Db } from "@buildx/db";
import {
  asc,
  claimNextQueuedRun,
  events as eventsTable,
  finalizeRun,
  getDb,
  heartbeatRun,
  inArray,
  isRunCancelled,
  readRunControl,
  recoverTimedOutRuns,
  releaseRunLease,
  runs as runsTable,
  sql,
  user,
} from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import {
  appendEvent,
  bindClaim,
  cancelRun,
  createRun,
  finishRun,
  flushAppends,
  getRun,
  listEventsAfter,
  listRunsForUser,
  markLostOwnership,
  persistStats,
  StaleRunError,
  type RunRow,
} from "./store";

loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const createdUsers: string[] = [];

try {
  db = getDb();
  await db.execute(sql`SELECT 1`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres unavailable: ${(error as Error).message}`;
}

async function ensureUser(id: string): Promise<void> {
  await db!.insert(user).values({
    id,
    name: "Test User",
    email: `${id}@test.local`,
  });
  createdUsers.push(id);
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await ensureUser(id);
  return id;
}

/** Claims this specific run directly (the global queue can pick another user's
 *  leftover run in a shared database, so lease-guard tests target their own). */
async function claimRunForTest(runId: string, leaseId: string): Promise<RunRow> {
  const [row] = await db!
    .update(runsTable)
    .set({
      status: "running",
      leaseId,
      fencingToken: sql`${runsTable.fencingToken} + 1`,
      leaseExpiresAt: sql`now() + interval '60 seconds'`,
      startedAt: new Date(),
    })
    .where(sql`${runsTable.id} = ${runId}`)
    .returning();
  assert.ok(row, "claim target must exist");
  return row;
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

/** A `Db` that rejects exactly the next `insert().values().returning()` query,
 *  then behaves normally. The fake builder keeps the drizzle chain shape so the
 *  store's `.values().returning()` call sites are exercised. */
function failingInsertOnce(database: Db): Db {
  let failed = false;
  return new Proxy(database, {
    get(target, prop) {
      if (prop === "execute") {
        return (...args: unknown[]) => {
          if (!failed) {
            failed = true;
            return Promise.reject(
              new Error("injected transient insert failure"),
            );
          }
          return (target as Db & { execute: (...a: unknown[]) => unknown }).execute(...args);
        };
      }
      if (prop === "insert") {
        return () => ({
          values: () => ({
            returning: () => {
              if (!failed) {
                failed = true;
                return Promise.reject(
                  new Error("injected transient insert failure"),
                );
              }
              throw new Error("the failing proxy was used more than once");
            },
          }),
        });
      }
      const value = (target as unknown as Record<string, unknown>)[String(prop)];
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

test("run, events and stats round-trip through Postgres", { skip: skipReason }, async () => {
  const uid = await newUser();

  const { run } = await createRun({
    userId: uid,
    workspaceName: "loop",
    task: "make a file",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  assert.equal(run.status, "queued");

  const claimed = await claimNextQueuedRun(db!, { leaseId: "lease-1" });
  assert.equal(claimed?.id, run.id, "enqueue-only row is claimable");
  assert.equal(claimed?.status, "running");
  await bindClaim(claimed!);
  assert.equal(run.leaseId, "lease-1");

  const t1 = Date.now();
  const first = await appendEvent(run, {
    type: "status",
    data: { status: "running" },
    ts: t1,
  });
  const second = await appendEvent(run, {
    type: "text",
    data: { text: "hello" },
    ts: t1 + 10,
  });
  assert.equal(second.id, first.id + 1, "event ids are monotonic");

  run.stats = {
    steps: 2,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
  await persistStats(run);
  assert.equal(await finishRun(run, "completed"), true);

  const [row] = await db!
    .select()
    .from(runsTable)
    .where(sql`${runsTable.id} = ${run.id}`);
  assert.equal(row.status, "completed");
  assert.equal(row.stepCount, 2);
  assert.equal(row.inputTokens, 10);
  assert.equal(row.endedAt instanceof Date, true);
  assert.equal(row.leaseId, null, "finalize releases the lease");

  const eventRows = await db!
    .select({ id: eventsTable.id, type: eventsTable.type })
    .from(eventsTable)
    .where(sql`${eventsTable.runId} = ${run.id}`)
    .orderBy(asc(eventsTable.id));
  assert.equal(eventRows.length, 2);
  assert.deepEqual(
    eventRows.map((e) => e.type),
    ["status", "text"],
  );

  const refreshed = await getRun(run.id);
  assert.equal(refreshed?.status, "completed");
  assert.equal(refreshed?.events.length, 2);
});

test("idempotencyKey replays the original run", { skip: skipReason }, async () => {
  const uid = await newUser();

  const first = await createRun({
    userId: uid,
    workspaceName: "idem",
    task: "twice",
    model: "gpt-4o-mini",
    maxSteps: 5,
    idempotencyKey: "post-run-1",
  });
  assert.equal(first.created, true);
  const second = await createRun({
    userId: uid,
    workspaceName: "idem",
    task: "twice",
    model: "gpt-4o-mini",
    maxSteps: 5,
    idempotencyKey: "post-run-1",
  });
  assert.equal(second.created, false, "a replay did not create a second row");
  assert.equal(second.run.id, first.run.id, "same key returns the original run");

  const other = await createRun({
    userId: uid,
    workspaceName: "idem",
    task: "once",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  assert.notEqual(other.run.id, first.run.id, "no key / different key queues a new run");

  const dbRuns = await db!
    .select()
    .from(runsTable)
    .where(sql`${runsTable.userId} = ${uid}`);
  assert.equal(dbRuns.length, 2);
});

test("cancelRun persists the flag and aborts the local controller", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "stop",
    task: "go until stopped",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  assert.equal(await cancelRun(run, "user requested"), true);
  assert.equal(run.runtime.controller.signal.aborted, true);
  const state = await isRunCancelled(db!, run.id);
  assert.equal(state.cancelled, true);
  assert.equal(state.reason, "user requested");

  // A second stop is a no-op so repeat requests don't re-target the run.
  assert.equal(await cancelRun(run), false);
});

test("cross-instance cancellation is observable via readRunControl", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "stop-remote",
    task: "go until stopped",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  const claimed = await claimRunForTest(run.id, "lease-stop");
  await bindClaim(claimed);

  // Another instance persists the stop without touching this process.
  await db!.execute(sql`
    UPDATE runs SET cancelled_at = now(), cancel_reason = 'stopped by the user'
    WHERE id = ${run.id}
  `);

  const control = await readRunControl(db!, {
    runId: run.id,
    leaseId: "lease-stop",
  });
  assert.equal(control.cancelled, true);
  assert.equal(control.reason, "stopped by the user");
  assert.equal(control.ownsLease, true, "we still own the lease, we just stop");

  // The worker answers the persisted flag; completed is refused on a cancelled run.
  assert.equal(await finishRun(run, "completed"), false);
  assert.equal(await finishRun(run, "cancelled", "stopped by the user"), true);
});

test("listEventsAfter returns only newer events plus the row status", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "replay",
    task: "replay me",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  await appendEvent(run, { type: "text", data: { text: "one" }, ts: Date.now() });
  const mid = await appendEvent(run, { type: "text", data: { text: "two" }, ts: Date.now() + 5 });
  const afterInsert = await appendEvent(run, { type: "text", data: { text: "three" }, ts: Date.now() + 10 });
  await flushAppends(run.id);

  const before = await listEventsAfter(run.id, 0);
  assert.equal(before.events.length, 3);
  assert.equal(before.status, "queued", "row status rides along");

  // Simulate a worker claiming it, then re-read the snapshot.
  await db!
    .update(runsTable)
    .set({ status: "running", leaseId: "lease-snap" })
    .where(sql`${runsTable.id} = ${run.id}`);

  const partial = await listEventsAfter(run.id, mid.id - 1);
  assert.deepEqual(
    partial.events
      .filter((e) => e.type === "text")
      .map((e) => e.data.text),
    ["two", "three"],
    "cursor is exclusive",
  );
  assert.equal(partial.status, "running");
  assert.equal(afterInsert.id > mid.id, true);
});

test("listRunsForUser excludes other users' runs", { skip: skipReason }, async () => {
  const uid = await newUser();
  const other = await newUser();

  const { run } = await createRun({
    userId: uid,
    workspaceName: "mine",
    task: "mine",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  await createRun({
    userId: other,
    workspaceName: "theirs",
    task: "theirs",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  const mine = await listRunsForUser(uid);
  assert.ok(mine.some((r) => r.id === run.id));
  assert.ok(mine.every((r) => r.userId === uid));
});

test("bindClaim propagates the claim so the worker never writes under a stale lease", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "bind",
    task: "bind me",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  // The cached object was hydrated as `queued`. Claim, then bind: the SAME
  // object must reflect the authoritative claim before the worker writes.
  const claimed = await claimRunForTest(run.id, "lease-propagate");
  assert.equal(claimed.id, run.id);

  const bound = await bindClaim(claimed);
  assert.equal(bound.id, run.id, "bind returns the process-local record");
  assert.equal(bound.status, "running", "claim status reaches the cached object");
  assert.equal(bound.leaseId, "lease-propagate");
  assert.equal(bound.runtime.lostOwnership, false);

  const event = await appendEvent(bound, {
    type: "status",
    data: { status: "running" },
    ts: Date.now(),
  });
  assert.ok(event.id > 0, "a bound worker can persist events");
  assert.equal(await finishRun(bound, "completed"), true);
  assert.equal(bound.leaseId, undefined, "finalize clears the local lease view");
});

test("appends and finalizes after a terminal transition are rejected", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "stale",
    task: "stale writes",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  const claimed = await claimRunForTest(run.id, "lease-term");
  await bindClaim(claimed);
  assert.equal(await finishRun(run, "completed"), true);

  await assert.rejects(
    appendEvent(run, { type: "text", data: { text: "late" }, ts: Date.now() }),
    StaleRunError,
    "a stale worker cannot append onto a completed run",
  );
  assert.equal(await finishRun(run, "failed"), false, "terminal is immutable");
});

test("lease loss fences the old owner and preserves the new owner's write access", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "fence",
    task: "fence me",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  // Worker A owns the run.
  const claimA = await claimRunForTest(run.id, "lease-A");
  assert.equal(claimA.id, run.id);
  const workerA = await bindClaim(claimA);
  assert.equal(
    (await readRunControl(db!, { runId: run.id, leaseId: "lease-A" })).ownsLease,
    true,
  );

  // A's lease lapses; recovery requeues the run and worker B reclaims it.
  await db!
    .update(runsTable)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(sql`${runsTable.id} = ${run.id}`);
  await recoverTimedOutRuns(db!);
  const claimB = await claimRunForTest(run.id, "lease-B");
  assert.equal(claimB.id, run.id, "recovered run is claimable again");

  // A's heartbeat fails and A fences itself (simulating A's own process).
  assert.equal(
    await heartbeatRun(db!, { runId: run.id, leaseId: "lease-A" }),
    false,
    "stale lease no longer heartbeats",
  );
  assert.equal(await releaseRunLease(db!, { runId: run.id, leaseId: "lease-A" }), false);
  markLostOwnership(run.id);
  assert.equal(workerA.runtime.lostOwnership, true);
  assert.equal(workerA.runtime.controller.signal.aborted, true, "fence stops the loop");

  await assert.rejects(
    appendEvent(workerA, { type: "text", data: { text: "late" }, ts: Date.now() }),
    StaleRunError,
    "a fenced process cannot keep emitting events",
  );
  await persistStats(workerA); // a fenced stats write is a silent no-op (no throw, no clobber)
  assert.equal(await finishRun(workerA, "failed"), false, "fenced owner cannot finalize");

  // Worker B binds the same process-local record, gets a clean signal, and runs.
  const workerB = await bindClaim(claimB!);
  assert.equal(workerB.runtime.lostOwnership, false);
  assert.equal(workerB.runtime.controller.signal.aborted, false);

  const event = await appendEvent(workerB, {
    type: "text",
    data: { text: "fresh start" },
    ts: Date.now(),
  });
  assert.ok(event.id > 0);
  assert.equal(await finishRun(workerB, "completed"), true);

  const [row] = await db!
    .select({ status: runsTable.status, error: runsTable.error })
    .from(runsTable)
    .where(sql`${runsTable.id} = ${run.id}`);
  assert.equal(row.status, "completed");
});

test("a failed append does not poison the chain and order is preserved", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "chain",
    task: "ordered events",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  const claimed = await claimRunForTest(run.id, "lease-chain");
  await bindClaim(claimed);

  // The FIRST append hits an injected transient insert failure...
  await assert.rejects(
    appendEvent(run, { type: "text", data: { text: "boom" }, ts: Date.now() }, { db: failingInsertOnce(db!) }),
    /injected transient insert failure/,
  );
  // ...and the SECOND append must still land (the tail recovers, never poisons).
  const ok = await appendEvent(run, { type: "text", data: { text: "after" }, ts: Date.now() });
  assert.ok(ok.id > 0);
  await flushAppends(run.id);

  const snapshot = await listEventsAfter(run.id, 0);
  assert.deepEqual(
    snapshot.events.filter((e) => e.type === "text").map((e) => e.data.text),
    ["after"],
    "failed event was surfaced (not persisted), following events survived",
  );

  // Concurrent appends persist in caller order.
  const p1 = appendEvent(run, { type: "text", data: { text: "1" }, ts: Date.now() });
  const p2 = appendEvent(run, { type: "text", data: { text: "2" }, ts: Date.now() + 1 });
  const p3 = appendEvent(run, { type: "text", data: { text: "3" }, ts: Date.now() + 2 });
  const p4 = appendEvent(run, { type: "text", data: { text: "4" }, ts: Date.now() + 3 });
  const p5 = appendEvent(run, { type: "text", data: { text: "5" }, ts: Date.now() + 4 });
  await Promise.all([p1, p2, p3, p4, p5]);

  const ordered = await listEventsAfter(run.id, snapshot.events.at(-1)!.id);
  assert.deepEqual(
    ordered.events.filter((e) => e.type === "text").map((e) => e.data.text),
    ["1", "2", "3", "4", "5"],
  );
  assert.equal(await finishRun(run, "completed"), true);
});

test("stale lease cannot append events after a new worker takes ownership with incremented fencing token", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "fencing-token",
    task: "test fencing",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  // Worker A claims with fencingToken 1
  const claimA = await claimRunForTest(run.id, "lease-worker-a");
  const workerA = await bindClaim(claimA);
  assert.equal(workerA.fencingToken, 1);

  // Worker A can append initially
  const ev1 = await appendEvent(workerA, { type: "text", data: { text: "from A" }, ts: Date.now() });
  assert.ok(ev1.id > 0);

  // Snapshot Worker A's stale lease+token before Worker B takes over
  const workerALeaseId = workerA.leaseId!;
  const workerAFencingToken = workerA.fencingToken!;

  // Worker B claims, incrementing fencingToken to 2
  const claimB = await claimRunForTest(run.id, "lease-worker-b");
  assert.equal(claimB.fencingToken, 2);

  // Restore Worker A's stale in-memory state (simulates a separate process still holding stale values)
  // bindClaim(claimB) would update them in a real multi-process setup, but we haven't called it yet
  workerA.leaseId = workerALeaseId;
  workerA.fencingToken = workerAFencingToken;
  // appendGuardedEvent enforces lease_id = 'lease-worker-a' AND fencing_token = 1 → fails in DB
  await assert.rejects(
    appendEvent(workerA, { type: "text", data: { text: "stale write from A" }, ts: Date.now() }),
    StaleRunError,
    "stale lease must be rejected atomically by PostgreSQL",
  );

  // Worker A is now marked as lost ownership (before bindClaim for B resets it)
  assert.equal(workerA.runtime.lostOwnership, true, "stale worker is fenced after DB rejection");

  // finishRun(workerA) is short-circuited by the in-memory lostOwnership guard before DB call
  assert.equal(await finishRun(workerA, "completed"), false, "stale worker cannot finalize (in-memory guard)");

  // Test DB-enforced finalize rejection directly using stale lease/token
  const staleFinalizeOk = await finalizeRun(db!, {
    runId: run.id,
    leaseId: workerALeaseId,
    fencingToken: workerAFencingToken,
    status: "completed",
  });
  assert.equal(staleFinalizeOk, false, "DB rejects finalize with stale lease/token");

  // Worker B binds, appends and finalizes successfully
  const workerB = await bindClaim(claimB);
  const ev2 = await appendEvent(workerB, { type: "text", data: { text: "from B" }, ts: Date.now() });
  assert.ok(ev2.id > ev1.id);
  assert.equal(await finishRun(workerB, "completed"), true, "new owner finalizes successfully");
});

test("expired lease cannot append events or finalize", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "expire-test",
    task: "test expiry",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  const claim = await claimRunForTest(run.id, "lease-expiring");
  const worker = await bindClaim(claim);

  // Manually expire the lease in the database
  await db!
    .update(runsTable)
    .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
    .where(sql`${runsTable.id} = ${run.id}`);
  // Keep worker's in-memory leaseExpiresAt as past too so application guard fires
  worker.leaseExpiresAt = Date.now() - 10_000;

  // Event append must be rejected by application or Postgres guard
  await assert.rejects(
    appendEvent(worker, { type: "text", data: { text: "should fail" }, ts: Date.now() }),
    StaleRunError,
    "expired lease cannot append events",
  );

  // Finalize must be rejected by Postgres guard (even if in-memory leaseExpiresAt is reset)
  worker.leaseExpiresAt = undefined;
  worker.runtime.lostOwnership = false;
  assert.equal(await finishRun(worker, "completed"), false, "expired lease cannot finalize");
});

test("progress events are rejected on cancelled run", { skip: skipReason }, async () => {
  const uid = await newUser();
  const { run } = await createRun({
    userId: uid,
    workspaceName: "cancel-guard",
    task: "test cancel guard",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  const claim = await claimRunForTest(run.id, "lease-cancel");
  const worker = await bindClaim(claim);

  // Cancel the run (must pass StoredRun, not id string)
  await cancelRun(worker, "stop requested");

  // cancelRun aborts worker.runtime.controller — reset it to bypass the in-memory abort guard
  // so we can test that the *database-level* cancelled_at guard rejects non-terminal events.
  worker.runtime.controller = new AbortController();
  worker.runtime.lostOwnership = false; // ensure in-memory path doesn't short-circuit

  // Non-terminal progress events must be rejected by the database guard
  // (appendGuardedEvent checks cancelled_at IS NULL unless it's a cancellation status event)
  await assert.rejects(
    appendEvent(worker, { type: "text", data: { text: "progress after cancel" }, ts: Date.now() }),
    StaleRunError,
    "progress events must not be appended to a cancelled run",
  );

  // The rejection sets lostOwnership=true; reset it to simulate the worker
  // continuing execution (as if it's a separate process that just learned of the cancel)
  // and now writing the terminal cancellation status event to close the run.
  worker.runtime.lostOwnership = false;
  worker.runtime.controller = new AbortController();

  // Terminal cancellation status event is accepted
  const terminalEv = await appendEvent(worker, {
    type: "status",
    data: { status: "cancelled", message: "stop requested" },
    ts: Date.now(),
  });
  assert.ok(terminalEv.id > 0);

  // Finalize as cancelled succeeds
  assert.equal(await finishRun(worker, "cancelled", "stop requested"), true);
});