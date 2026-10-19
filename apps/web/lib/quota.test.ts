import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAILY_MODEL_REQUEST_LIMIT,
  QuotaExceededError,
  QuotaServiceUnavailableError,
  createQuotaService,
  quotaWindow,
  type QuotaRedis,
} from "./quota";

class FakeRedis implements QuotaRedis {
  readonly counts = new Map<string, number>();
  readonly attempts = new Map<string, string>();

  async eval<T>(script: string, keys: string[], args: string[]): Promise<T> {
    if (script.includes("INCR")) {
      const [counterKey, attemptKey] = keys;
      const used = this.counts.get(counterKey) ?? 0;
      if (this.attempts.has(attemptKey)) return [used, 1, 1] as T;
      const limit = Number(args[0]);
      if (used >= limit) return [used, 0, 0] as T;
      const next = used + 1;
      this.counts.set(counterKey, next);
      this.attempts.set(attemptKey, "reserved");
      return [next, 1, 0] as T;
    }
    if (script.includes("KEEPTTL")) {
      const [attemptKey] = keys;
      if (!this.attempts.has(attemptKey)) return 0 as T;
      this.attempts.set(attemptKey, args[0]);
      return 1 as T;
    }
    throw new Error("unknown script");
  }

  async get<T>(key: string): Promise<T> {
    return (this.counts.get(key) ?? null) as T;
  }
}

const FIXED_NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

test("quotaWindow uses the Asia/Dhaka day and midnight reset", () => {
  const window = quotaWindow(FIXED_NOW);
  assert.equal(window.day, "2026-10-19");
  assert.equal(
    window.resetAt,
    Date.UTC(2026, 9, 19, 18, 0, 0),
    "reset is 00:00 Asia/Dhaka (18:00 UTC)",
  );
});

test("quotaWindow rolls over exactly at Dhaka midnight", () => {
  const before = quotaWindow(Date.UTC(2026, 9, 19, 17, 59, 59));
  const after = quotaWindow(Date.UTC(2026, 9, 19, 18, 0, 0));
  assert.equal(before.day, "2026-10-19");
  assert.equal(after.day, "2026-10-20");
});

test("the 51st model request of the day is rejected", async () => {
  const redis = new FakeRedis();
  const service = createQuotaService({ redis, now: () => FIXED_NOW });

  for (let i = 0; i < DAILY_MODEL_REQUEST_LIMIT; i += 1) {
    const reservation = await service.reserve("user-1", `attempt-${i}`);
    assert.equal(reservation.allowed, true);
  }

  const snapshot = await service.read("user-1");
  assert.deepEqual(snapshot, {
    limit: 50,
    used: 50,
    remaining: 0,
    resetAt: Date.UTC(2026, 9, 19, 18, 0, 0),
  });

  await assert.rejects(
    () => service.reserve("user-1", "attempt-50"),
    (error: unknown) =>
      error instanceof QuotaExceededError &&
      error.snapshot.used === 50 &&
      error.snapshot.remaining === 0,
  );
});

test("reserving the same attempt twice is idempotent", async () => {
  const redis = new FakeRedis();
  const service = createQuotaService({ redis, now: () => FIXED_NOW });

  const first = await service.reserve("user-1", "attempt-1");
  const second = await service.reserve("user-1", "attempt-1");

  assert.equal(first.allowed, true);
  assert.equal(second.duplicate, true);
  assert.equal((await service.read("user-1")).used, 1);
});

test("usage counts per user, not globally", async () => {
  const redis = new FakeRedis();
  const service = createQuotaService({ redis, now: () => FIXED_NOW });

  for (let i = 0; i < 50; i += 1) {
    await service.reserve("user-1", `u1-${i}`);
  }
  const other = await service.reserve("user-2", "u2-0");
  assert.equal(other.snapshot.used, 1);
});

test("the counter resets on the next Dhaka day", async () => {
  const redis = new FakeRedis();
  let now = FIXED_NOW;
  const service = createQuotaService({ redis, now: () => now });

  await service.reserve("user-1", "before");
  now = Date.UTC(2026, 9, 19, 18, 0, 1);
  const snapshot = await service.read("user-1");
  assert.equal(snapshot.used, 0);
  assert.equal(snapshot.resetAt, Date.UTC(2026, 9, 20, 18, 0, 0));
});

test("a Redis failure is surfaced as service unavailable", async () => {
  const service = createQuotaService({
    redis: {
      eval: async () => {
        throw new Error("ECONNREFUSED");
      },
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
    now: () => FIXED_NOW,
  });

  await assert.rejects(
    () => service.reserve("user-1", "attempt"),
    (error: unknown) => error instanceof QuotaServiceUnavailableError,
  );
  await assert.rejects(
    () => service.read("user-1"),
    (error: unknown) => error instanceof QuotaServiceUnavailableError,
  );
});

test("reservation lifecycle transitions are stored without refunding", async () => {
  const redis = new FakeRedis();
  const service = createQuotaService({ redis, now: () => FIXED_NOW });

  await service.reserve("user-1", "attempt");
  await service.markDispatched("user-1", "attempt");
  await service.settle("user-1", "attempt", "failed");

  const attemptKey = [...redis.attempts.keys()][0];
  assert.equal(redis.attempts.get(attemptKey), "settled:failed");
  assert.equal((await service.read("user-1")).used, 1);
});
