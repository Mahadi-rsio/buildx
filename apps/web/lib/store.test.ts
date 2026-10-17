import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Db } from "@buildx/db";
import {
  asc,
  claimNextQueuedRun,
  events as eventsTable,
  getDb,
  inArray,
  isRunCancelled,
  runs as runsTable,
  sql,
  user,
} from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import {
  appendEvent,
  cancelRun,
  createRun,
  finishRun,
  flushAppends,
  getRun,
  listEventsAfter,
  listRunsForUser,
  persistStats,
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

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("run, events and stats round-trip through Postgres", { skip: skipReason }, async () => {
  const uid = await newUser();

  const run = await createRun({
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
  run.leaseId = claimed!.leaseId ?? "lease-1";

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
  const second = await createRun({
    userId: uid,
    workspaceName: "idem",
    task: "twice",
    model: "gpt-4o-mini",
    maxSteps: 5,
    idempotencyKey: "post-run-1",
  });
  assert.equal(second.id, first.id, "same key returns the original run");

  const other = await createRun({
    userId: uid,
    workspaceName: "idem",
    task: "once",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  assert.notEqual(other.id, first.id, "no key / different key queues a new run");

  const dbRuns = await db!
    .select()
    .from(runsTable)
    .where(sql`${runsTable.userId} = ${uid}`);
  assert.equal(dbRuns.length, 2);
});

test("cancelRun persists the flag and aborts the local controller", { skip: skipReason }, async () => {
  const uid = await newUser();
  const run = await createRun({
    userId: uid,
    workspaceName: "stop",
    task: "go until stopped",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });

  assert.equal(await cancelRun(run, "user requested"), true);
  assert.equal(run.controller.signal.aborted, true);
  const state = await isRunCancelled(db!, run.id);
  assert.equal(state.cancelled, true);
  assert.equal(state.reason, "user requested");

  // A second stop is a no-op so repeat requests don't re-target the run.
  assert.equal(await cancelRun(run), false);
});

test("listEventsAfter returns only newer events plus the row status", { skip: skipReason }, async () => {
  const uid = await newUser();
  const run = await createRun({
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

  const run = await createRun({
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