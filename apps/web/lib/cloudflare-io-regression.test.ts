import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { getDb, sql, user, session as sessionTable, account, runs as runsTable, type Db } from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import { auth } from "./auth/auth";
import { getCurrentUser, getSession } from "./auth/server";
import { createRun, listRunsForUser } from "./store";
import { enqueueRunForUser } from "./run-creation";
import { GET, POST } from "../app/api/runs/route";

loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const cleanupUserIds: string[] = [];
const cleanupRunIds: string[] = [];

try {
  db = getDb();
  await db.execute(sql`SELECT 1`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres unavailable: ${(error as Error).message}`;
}

after(async () => {
  if (skipReason || !db) return;
  if (cleanupRunIds.length > 0) {
    for (const runId of cleanupRunIds) {
      await db.delete(runsTable).where(sql`id = ${runId}`).catch(() => undefined);
    }
  }
  if (cleanupUserIds.length > 0) {
    for (const uid of cleanupUserIds) {
      await db.delete(sessionTable).where(sql`user_id = ${uid}`).catch(() => undefined);
      await db.delete(account).where(sql`user_id = ${uid}`).catch(() => undefined);
      await db.delete(user).where(sql`id = ${uid}`).catch(() => undefined);
    }
  }
});

interface AuthTestContext {
  userId: string;
  cookie: string;
  createRequest: () => Request;
}

async function createAuthenticatedUser(): Promise<AuthTestContext> {
  const email = `cf-test-${randomUUID()}@test.local`;
  const res = await auth.api.signUpEmail({
    body: {
      email,
      password: "password123456",
      name: "CF Regression Test User",
    },
    asResponse: true,
  });

  assert.equal(res.status, 200, "Sign up must succeed");
  const cookie = res.headers.get("set-cookie") || "";
  assert.ok(cookie.length > 0, "Must return set-cookie header");

  const headers = new Headers();
  headers.set("cookie", cookie);
  const session = await auth.api.getSession({ headers });
  assert.ok(session?.user?.id, "Session must resolve to user");

  const userId = session.user.id;
  cleanupUserIds.push(userId);

  return {
    userId,
    cookie,
    createRequest: () =>
      new Request("https://buildx.rsioex.workers.dev/api/runs", {
        headers: { cookie },
      }),
  };
}

test(
  "Database access independently: handles sequential and concurrent queries without I/O context errors",
  { skip: skipReason },
  async () => {
    const testDb = getDb();

    // 1. Sequential queries across simulated request boundaries
    for (let i = 0; i < 5; i++) {
      const result = await testDb.execute(sql`SELECT ${i} AS num`);
      assert.ok(result, `Sequential query ${i} must succeed`);
    }

    // 2. Concurrent queries hitting the shared client
    const concurrentQueries = Array.from({ length: 8 }, (_, i) =>
      testDb.execute(sql`SELECT ${i} AS num`),
    );
    const results = await Promise.all(concurrentQueries);
    assert.equal(results.length, 8, "All 8 concurrent queries must resolve");
  },
);

test(
  "Session lookup independently: handles sequential and concurrent session verifications",
  { skip: skipReason },
  async () => {
    const { userId, cookie } = await createAuthenticatedUser();
    const headers = new Headers({ cookie });

    // 1. Sequential session lookups (simulating distinct sequential requests)
    for (let i = 0; i < 4; i++) {
      const session = await getSession(headers);
      assert.ok(session, `Sequential session lookup ${i} must return valid session`);
      assert.equal(session.user.id, userId);

      const currentUser = await getCurrentUser(headers);
      assert.ok(currentUser, `Sequential getCurrentUser ${i} must return user`);
      assert.equal(currentUser.id, userId);
    }

    // 2. Concurrent session lookups (simulating racing requests)
    const concurrentLookups = Array.from({ length: 6 }, async () => {
      const s = await getSession(headers);
      assert.equal(s?.user?.id, userId);
      return s;
    });

    const sessions = await Promise.all(concurrentLookups);
    assert.equal(sessions.length, 6);
  },
);

test(
  "GET /api/runs: sequential authenticated requests succeed without I/O errors",
  { skip: skipReason },
  async () => {
    const { userId, createRequest } = await createAuthenticatedUser();

    // Seed test runs for this user
    const { run: run1 } = await createRun({
      userId,
      workspaceName: "cf-test-ws-1",
      task: "Task 1",
      model: "gpt-4o",
      maxSteps: 5,
    });
    cleanupRunIds.push(run1.id);

    const { run: run2 } = await createRun({
      userId,
      workspaceName: "cf-test-ws-2",
      task: "Task 2",
      model: "gpt-4o",
      maxSteps: 5,
    });
    cleanupRunIds.push(run2.id);

    // Verify listRunsForUser directly
    const directRuns = await listRunsForUser(userId);
    assert.equal(directRuns.length, 2, "listRunsForUser must find seeded runs");

    // Sequential GET requests across simulated request instances
    for (let i = 0; i < 3; i++) {
      const req = createRequest();
      const res = await GET(req);
      assert.equal(res.status, 200, `Sequential GET /api/runs request ${i} must return 200`);

      const body = (await res.json()) as { runs: Array<{ id: string; task: string }> };
      assert.ok(Array.isArray(body.runs), "Response must contain runs array");
      assert.equal(body.runs.length, 2, "Response must return user runs");
      assert.ok(body.runs.some((r) => r.id === run1.id));
      assert.ok(body.runs.some((r) => r.id === run2.id));
    }
  },
);

test(
  "GET /api/runs: concurrent authenticated requests succeed without I/O context errors or hangs",
  { skip: skipReason },
  async () => {
    const { userId, createRequest } = await createAuthenticatedUser();

    const { run } = await createRun({
      userId,
      workspaceName: "cf-concurrent-ws",
      task: "Concurrent Run Task",
      model: "gpt-4o",
      maxSteps: 5,
    });
    cleanupRunIds.push(run.id);

    // Dispatch 6 concurrent requests simulating simultaneous client calls
    const requests = Array.from({ length: 6 }, () => createRequest());
    const responses = await Promise.all(requests.map((req) => GET(req)));

    for (const [idx, res] of responses.entries()) {
      assert.equal(res.status, 200, `Concurrent response ${idx} must be 200 OK`);
      const body = (await res.json()) as { runs: Array<{ id: string }> };
      assert.ok(body.runs.length >= 1, `Concurrent response ${idx} must return runs`);
      assert.ok(body.runs.some((r) => r.id === run.id));
    }
  },
);

test("GET /api/runs: unauthenticated request returns 401 without error", async () => {
  const req = new Request("https://buildx.rsioex.workers.dev/api/runs", {
    headers: {},
  });
  const res = await GET(req);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "unauthorized");
});

test(
  "POST /api/runs: authenticated request enqueues a run and returns 201 with summary",
  { skip: skipReason },
  async () => {
    const origKey = process.env.OPENAI_API_KEY;
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = "sk-test-key-for-regression";
    }

    try {
      const { cookie } = await createAuthenticatedUser();
      const req = new Request("https://buildx.rsioex.workers.dev/api/runs", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          task: "Test task from automated regression test",
          model: "gpt-4o",
        }),
      });

      const res = await POST(req);
      assert.equal(res.status, 201, `POST /api/runs must return 201 Created`);
      const body = (await res.json()) as { id: string; status: string; task: string };
      assert.ok(body.id, "Response must include run id");
      assert.equal(body.status, "queued");
      assert.equal(body.task, "Test task from automated regression test");
      cleanupRunIds.push(body.id);
    } finally {
      process.env.OPENAI_API_KEY = origKey;
    }
  },
);

test(
  "enqueueRunForUser: succeeds against NeonHttpDatabase driver without throwing transaction error",
  { skip: skipReason },
  async () => {
    const { userId } = await createAuthenticatedUser();

    // Create a proxy DB that simulates NeonHttpDatabase throwing on transaction()
    const realDb = getDb();
    const simulatedNeonHttpDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "constructor") {
          return { name: "NeonHttpDatabase" };
        }
        if (prop === "transaction") {
          return () => {
            throw new Error("No transactions support in neon-http driver");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await enqueueRunForUser({
      user: {
        id: userId,
        email: `test-${userId}@test.local`,
      },
      task: "Simulated Neon HTTP Driver Run",
      model: "gpt-4o",
      maxSteps: 5,
      db: simulatedNeonHttpDb as Db,
    });

    assert.equal(result.kind, "created");
    assert.ok(result.run.id);
    cleanupRunIds.push(result.run.id);
  },
);

