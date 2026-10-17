import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Db } from "@buildx/db";
import { getDb, inArray, sql, user } from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import { findOwnedRun, notFound } from "./authz";
import { createRun, listRunsForUser } from "./store";

/**
 * Real-Postgres tests (docker compose), mirroring packages/db. When the
 * database is unreachable the suite skips, so `pnpm test` still passes
 * without infra.
 */
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

/** A run's `user_id` must exist in `user` (FK), so create one per test. */
async function ensureUser(id: string): Promise<void> {
  await db!.insert(user).values({
    id,
    name: "Test User",
    email: `${id}@test.local`,
  });
  createdUsers.push(id);
}

let seq = 0;
async function makeRun(userId: string) {
  seq += 1;
  return createRun({
    userId,
    workspaceName: "ws",
    task: `task ${seq}`,
    model: "gpt-4o-mini",
    maxSteps: 5,
  });
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("findOwnedRun returns a run to its owner", { skip: skipReason }, async () => {
  const uid = randomUUID();
  await ensureUser(uid);
  const run = await makeRun(uid);
  assert.equal((await findOwnedRun(run.id, uid))?.id, run.id);
});

test("findOwnedRun hides a run from other users", { skip: skipReason }, async () => {
  const owner = randomUUID();
  await ensureUser(owner);
  const run = await makeRun(owner);
  assert.equal(await findOwnedRun(run.id, randomUUID()), undefined);
});

test("findOwnedRun returns undefined for unknown ids", { skip: skipReason }, async () => {
  assert.equal(await findOwnedRun(randomUUID(), randomUUID()), undefined);
});

test("listRunsForUser only returns the caller's runs", { skip: skipReason }, async () => {
  const mine = randomUUID();
  await ensureUser(mine);
  const other = randomUUID();
  await ensureUser(other);

  const myRun = await makeRun(mine);
  await makeRun(other);

  const listed = await listRunsForUser(mine);
  assert.ok(listed.some((run) => run.id === myRun.id));
  assert.ok(listed.every((run) => run.userId === mine));
});

test("notFound answers 404 with the resource id", async () => {
  const response = notFound("run_x");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "not_found",
    id: "run_x",
  });
});