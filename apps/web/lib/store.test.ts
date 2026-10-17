import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Db } from "@buildx/db";
import {
  asc,
  events as eventsTable,
  getDb,
  inArray,
  runs as runsTable,
  sql,
  user,
} from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import {
  appendEvent,
  createRun,
  finishRun,
  getRun,
  listRunsForUser,
  markRunning,
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

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("run, events and stats round-trip through Postgres", { skip: skipReason }, async () => {
  const uid = randomUUID();
  await ensureUser(uid);

  const run = await createRun({
    userId: uid,
    workspaceName: "loop",
    task: "make a file",
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
  assert.equal(run.status, "queued");

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

  await markRunning(run);
  run.stats = {
    steps: 2,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
  await persistStats(run);
  await finishRun(run, "completed");

  const [row] = await db!
    .select()
    .from(runsTable)
    .where(sql`${runsTable.id} = ${run.id}`);
  assert.equal(row.status, "completed");
  assert.equal(row.stepCount, 2);
  assert.equal(row.inputTokens, 10);
  assert.equal(row.endedAt instanceof Date, true);

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

test("listRunsForUser excludes other users' runs", { skip: skipReason }, async () => {
  const uid = randomUUID();
  const other = randomUUID();
  await ensureUser(uid);
  await ensureUser(other);

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