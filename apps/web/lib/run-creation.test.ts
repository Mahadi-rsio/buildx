import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Db } from "@buildx/db";
import {
  DAILY_REQUEST_LIMIT,
  dailyRequestCount,
  dailyRequests,
  dhakaDay,
  getDb,
  inArray,
  runs as runsTable,
  sql,
  user,
} from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import { enqueueRunForUser } from "./run-creation";

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

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({
    id,
    name: "Run Creation Test",
    email: `creation-${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

function inputFor(uid: string, idempotencyKey?: string) {
  return {
    user: { id: uid, name: "Test User", email: `test-${uid}@test.local` },
    task: "make a file",
    model: "gpt-4o-mini",
    maxSteps: 5,
    idempotencyKey,
    db: db!,
  };
}

async function countRuns(uid: string): Promise<number> {
  const rows = await db!
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(sql`${runsTable.userId} = ${uid}`);
  return rows.length;
}

/** A `Db` whose next `insert().values().returning()` query fails once, then
 *  behaves normally. Keeps the drizzle chain shape so the store's call sites
 *  are exercised. */
function failingInsertOnce(database: Db): Db {
  let failed = false;
  return new Proxy(database, {
    get(target, prop) {
      if (prop === "insert") {
        return () => ({
          values: () => ({
            returning: () => {
              if (!failed) {
                failed = true;
                return Promise.reject(new Error("injected insert failure"));
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

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("idempotency replay returns the original run and consumes quota once", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  const first = await enqueueRunForUser(inputFor(uid, "post-a"));
  assert.equal(first.kind, "created");
  if (first.kind !== "created") return;

  const second = await enqueueRunForUser(inputFor(uid, "post-a"));
  assert.equal(second.kind, "replayed");
  assert.equal(second.kind === "replayed" && second.run.id, first.run.id);

  assert.equal(await countRuns(uid), 1, "one retried POST queues one run");
  assert.equal(await dailyRequestCount(db!, uid, day), 1, "a replay does not double-charge");

  const third = await enqueueRunForUser(inputFor(uid));
  assert.equal(third.kind, "created");
  const dayCountAfter = await dailyRequestCount(db!, uid, day);
  assert.equal(dayCountAfter, 2, "a genuinely new run consumes a new slot");
});

test("a day already at the limit is rejected before anything is queued", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  await db!.insert(dailyRequests).values({ userId: uid, day, count: DAILY_REQUEST_LIMIT });

  const result = await enqueueRunForUser(inputFor(uid, "post-full"));
  assert.equal(result.kind, "quota_exhausted");
  assert.equal(await countRuns(uid), 0, "no run row is created over the limit");
});

test("concurrent submissions with the same key produce exactly one run and one charge", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => enqueueRunForUser(inputFor(uid, "post-race"))),
  );

  const created = results.filter((r) => r.kind === "created");
  const replayed = results.filter((r) => r.kind === "replayed");
  assert.equal(created.length, 1, "only one of the racing requests creates the run");
  assert.equal(replayed.length, 4, "the rest replay the winner");
  const ids = new Set(results.map((r) => r.kind !== "quota_exhausted" && r.run.id));
  assert.equal(ids.size, 1, "every caller sees the same run");

  assert.equal(await countRuns(uid), 1);
  assert.equal(await dailyRequestCount(db!, uid, day), 1, "exactly one quota slot consumed");
});

test("a failed creation does not consume a quota slot", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  await assert.rejects(
    enqueueRunForUser({
      ...inputFor(uid),
      db: failingInsertOnce(db!),
    }),
    /injected insert failure/,
  );

  assert.equal(await countRuns(uid), 0, "the failed insert left no run row");
  assert.equal(await dailyRequestCount(db!, uid, day), 0, "quota is untouched on failure");
});