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
import { createRunForUser } from "./run-creation";

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

function failingInsertOnce(database: Db): Db {
  let failed = false;
  const wrap = (dbTarget: Db): Db =>
    new Proxy(dbTarget, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (fn: (tx: Db) => Promise<unknown>) =>
            (target as Db & { transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> }).transaction((tx: Db) => fn(wrap(tx)));
        }
        if (prop === "insert") {
          return (table: unknown) => {
            const isRuns =
              table === runsTable ||
              (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] === "runs";
            if (isRuns) {
              return {
                values: () => ({
                  returning: () => {
                    if (!failed) {
                      failed = true;
                      return Promise.reject(new Error("injected insert failure"));
                    }
                    throw new Error("the failing proxy was used more than once");
                  },
                }),
              };
            }
            return (target as Db & { insert: (t: unknown) => unknown }).insert(table);
          };
        }
        const value = (target as unknown as Record<string, unknown>)[String(prop)];
        if (typeof value === "function") return value.bind(target);
        return value;
      },
    });
  return wrap(database);
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("idempotency replay returns the original run and consumes quota once", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  const first = await createRunForUser(inputFor(uid, "post-a"));
  assert.equal(first.kind, "created");
  if (first.kind !== "created") return;

  const second = await createRunForUser(inputFor(uid, "post-a"));
  assert.equal(second.kind, "replayed");
  assert.equal(second.kind === "replayed" && second.run.id, first.run.id);

  assert.equal(await countRuns(uid), 1, "one retried POST queues one run");
  assert.equal(await dailyRequestCount(db!, uid, day), 1, "a replay does not double-charge");

  const third = await createRunForUser(inputFor(uid));
  assert.equal(third.kind, "created");
  const dayCountAfter = await dailyRequestCount(db!, uid, day);
  assert.equal(dayCountAfter, 2, "a genuinely new run consumes a new slot");
});

test("a day already at the limit is rejected before anything is queued", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  await db!.insert(dailyRequests).values({ userId: uid, day, count: DAILY_REQUEST_LIMIT });

  const result = await createRunForUser(inputFor(uid, "post-full"));
  assert.equal(result.kind, "quota_exhausted");
  assert.equal(await countRuns(uid), 0, "no run row is created over the limit");
});

test("concurrent submissions with the same key produce exactly one run and one charge", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => createRunForUser(inputFor(uid, "post-race"))),
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
    createRunForUser({
      ...inputFor(uid),
      db: failingInsertOnce(db!),
    }),
    /injected insert failure/,
  );

  assert.equal(await countRuns(uid), 0, "the failed insert left no run row");
  assert.equal(await dailyRequestCount(db!, uid, day), 0, "quota is untouched on failure");
});

test("concurrent run creation at the quota limit allows exactly one winner", { skip: skipReason }, async () => {
  const uid = await newUser();
  const day = dhakaDay();

  // Pre-fill to 1 slot before DAILY_REQUEST_LIMIT
  await db!.insert(dailyRequests).values({
    userId: uid,
    day,
    count: DAILY_REQUEST_LIMIT - 1,
  });

  // 5 distinct requests race for that single slot
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      createRunForUser(inputFor(uid, `race-limit-${i}`)),
    ),
  );

  const created = results.filter((r) => r.kind === "created");
  const exhausted = results.filter((r) => r.kind === "quota_exhausted");

  assert.equal(created.length, 1, "exactly one request claims the final quota slot");
  assert.equal(exhausted.length, 4, "all other racing requests receive quota_exhausted");
  assert.equal(await countRuns(uid), 1, "only one run was created in the database");
  assert.equal(
    await dailyRequestCount(db!, uid, day),
    DAILY_REQUEST_LIMIT,
    "quota count strictly caps at the limit and cannot be bypassed",
  );
});

test("worker claiming during in-flight creation cannot claim uncommitted run", { skip: skipReason }, async () => {
  const uid = await newUser();
  const runId = randomUUID();

  // Barrier 1: signals that the row has been inserted but the tx is still open
  let signalOutsideCheckDone!: () => void;
  const outsideCheckDone = new Promise<void>((r) => { signalOutsideCheckDone = r; });

  // Barrier 2: lets the transaction proceed to commit
  let signalAllowCommit!: () => void;
  const allowCommit = new Promise<void>((r) => { signalAllowCommit = r; });

  // Run the transaction in the background — do NOT await yet
  const txPromise = db!.transaction(async (tx) => {
    await tx.insert(runsTable).values({
      id: runId,
      userId: uid,
      task: "in-flight task",
      model: "gpt-4o-mini",
      maxSteps: 5,
      workspaceName: "workspace-flight",
      status: "queued",
    });

    // Row inserted inside tx. Signal that the outside check can now run.
    signalOutsideCheckDone();

    // Hold the transaction open until the outside check finishes.
    await allowCommit;
  });

  // Wait for the insert to have happened (tx still open, row uncommitted)
  await outsideCheckDone;

  // From a different connection (pool), verify the row is invisible (READ COMMITTED isolation)
  const rowsOutside = await db!
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(sql`${runsTable.id} = ${runId}`);
  const foundInFlight = rowsOutside.length > 0;

  // Let the transaction commit
  signalAllowCommit();
  await txPromise;

  assert.equal(
    foundInFlight,
    false,
    "worker must never see or claim an uncommitted in-flight run",
  );

  // After commit the run must be visible
  const [rowAfter] = await db!
    .select({ id: runsTable.id, status: runsTable.status })
    .from(runsTable)
    .where(sql`${runsTable.id} = ${runId}`);
  assert.equal(rowAfter?.id, runId, "run is visible after transaction commits");
  assert.equal(rowAfter?.status, "queued");
});