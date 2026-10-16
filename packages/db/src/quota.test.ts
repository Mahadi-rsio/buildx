import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { loadRootEnv } from "@buildx/shared/node";
import { getDb, type Db } from "./client";
import {
  DAILY_REQUEST_LIMIT,
  canStartRun,
  closeUsageSession,
  consumeDailyRequest,
  countActiveRuns,
  dailyRequestCount,
  monthlyCpuSecondsUsed,
  nextDhakaReset,
  openUsageSession,
  refundDailyRequest,
} from "./quota";
import { runs, usageSessions, user, workspaces } from "./schema";
import { transition } from "./transition";

/**
 * Real-Postgres tests (docker compose). When the database is unreachable the
 * suite skips, so `pnpm test` still passes without infra.
 */
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

/** A fresh user per test (workspaces are UNIQUE per user). */
async function newUser(): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({
    id,
    name: "Test User",
    email: `${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

async function newWorkspace(userId: string, name: string): Promise<string> {
  const [row] = await db!
    .insert(workspaces)
    .values({ userId, name })
    .returning({ id: workspaces.id });
  return row.id;
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("transition is a single conditional UPDATE", { skip: skipReason }, async () => {
  const userId = await newUser();
  const workspaceId = await newWorkspace(userId, "w");

  assert.equal(
    await transition(db!, workspaces, workspaceId, "creating", "running"),
    true,
  );
  assert.equal(
    await transition(db!, workspaces, workspaceId, "creating", "archived"),
    false,
  );
  const [row] = await db!
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  assert.equal(row.status, "running");
});

test("daily counter never exceeds the limit under 100 concurrent requests", { skip: skipReason }, async () => {
  const userId = await newUser();
  const day = "2000-01-01";
  const results = await Promise.all(
    Array.from({ length: 100 }, () => consumeDailyRequest(db!, userId, day)),
  );

  const allowed = results.filter((value) => value !== null);
  assert.equal(allowed.length, DAILY_REQUEST_LIMIT);
  assert.equal(await dailyRequestCount(db!, userId, day), DAILY_REQUEST_LIMIT);
});

test("refunding decrements but never below zero", { skip: skipReason }, async () => {
  const userId = await newUser();
  const day = "2000-01-02";
  await consumeDailyRequest(db!, userId, day);
  await consumeDailyRequest(db!, userId, day);
  await refundDailyRequest(db!, userId, day);
  assert.equal(await dailyRequestCount(db!, userId, day), 1);

  await refundDailyRequest(db!, userId, day);
  await refundDailyRequest(db!, userId, day);
  assert.equal(await dailyRequestCount(db!, userId, day), 0);
});

test("monthly CPU seconds include closed and open sessions", { skip: skipReason }, async () => {
  const userId = await newUser();
  const workspaceId = await newWorkspace(userId, "cpu");

  const now = Date.now();
  await db!.insert(usageSessions).values([
    {
      userId,
      workspaceId,
      startedAt: new Date(now - 200_000),
      endedAt: new Date(now - 80_000),
    },
    { userId, workspaceId, startedAt: new Date(now - 60_000), endedAt: null },
  ]);

  const seconds = await monthlyCpuSecondsUsed(db!, userId);
  assert.ok(
    seconds >= 170 && seconds <= 190,
    `expected ~180s of CPU, got ${seconds}`,
  );
});

test("open/close usage session round-trips", { skip: skipReason }, async () => {
  const userId = await newUser();
  const workspaceId = await newWorkspace(userId, "session");

  const sessionId = await openUsageSession(db!, {
    userId,
    workspaceId,
    machineId: "m1",
  });
  assert.equal(await closeUsageSession(db!, sessionId), true);
  assert.equal(await closeUsageSession(db!, sessionId), false);
});

test("only one run may be running per user", { skip: skipReason }, async () => {
  const userId = await newUser();
  assert.equal(await canStartRun(db!, userId), true);

  await db!.insert(runs).values({ userId, status: "running", model: "test" });
  assert.equal(await countActiveRuns(db!, userId), 1);
  assert.equal(await canStartRun(db!, userId), false);

  await assert.rejects(() =>
    db!.insert(runs).values({ userId, status: "running", model: "test" }),
  );
});

test("nextDhakaReset is the next Asia/Dhaka midnight", () => {
  const reset = nextDhakaReset(new Date("2026-01-15T10:00:00Z"));
  assert.equal(reset.toISOString(), "2026-01-15T18:00:00.000Z");
});
