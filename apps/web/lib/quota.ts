import { Redis } from "@upstash/redis";

/**
 * Hard daily cap on actual upstream model invocations per user. Every model
 * step (including tool-loop iterations, retries and fallbacks) reserves one
 * unit before the request leaves the app.
 */
export const DAILY_MODEL_REQUEST_LIMIT = 150;

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuotaSnapshot {
  limit: number;
  used: number;
  remaining: number;
  /** Unix epoch milliseconds of the next Asia/Dhaka midnight. */
  resetAt: number;
}

export interface QuotaWindow {
  /** Calendar day in Asia/Dhaka (`YYYY-MM-DD`). */
  day: string;
  /** Unix epoch seconds of the next Asia/Dhaka midnight. */
  resetAtSeconds: number;
  /** Unix epoch milliseconds of the next Asia/Dhaka midnight. */
  resetAt: number;
}

export interface QuotaReservation {
  attemptId: string;
  allowed: boolean;
  duplicate: boolean;
  snapshot: QuotaSnapshot;
}

export class QuotaExceededError extends Error {
  readonly snapshot: QuotaSnapshot;

  constructor(snapshot: QuotaSnapshot) {
    super(
      `Daily AI request limit reached (${snapshot.used}/${snapshot.limit}). ` +
        "It resets at midnight Asia/Dhaka.",
    );
    this.name = "QuotaExceededError";
    this.snapshot = snapshot;
  }
}

export class QuotaServiceUnavailableError extends Error {
  constructor(message = "Quota service is unavailable; refusing to run.", cause?: unknown) {
    super(message);
    this.name = "QuotaServiceUnavailableError";
    this.cause = cause;
  }
}

/** Minimal Redis surface so tests can inject an in-memory fake. */
export interface QuotaRedis {
  eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
  get<T = unknown>(key: string): Promise<T | null>;
}

export interface QuotaService {
  read(userId: string): Promise<QuotaSnapshot>;
  reserve(userId: string, attemptId: string): Promise<QuotaReservation>;
  markDispatched(userId: string, attemptId: string): Promise<void>;
  settle(
    userId: string,
    attemptId: string,
    result: "succeeded" | "failed",
  ): Promise<void>;
}

export interface QuotaBackend {
  redis: QuotaRedis;
  now?: () => number;
  limit?: number;
}

/**
 * Asia/Dhaka is a fixed UTC+6 offset (no DST), so the window can be derived
 * without a timezone database. Never accept the browser's clock for this.
 */
export function quotaWindow(now = Date.now()): QuotaWindow {
  const shifted = new Date(now + DHAKA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const date = shifted.getUTCDate();
  const dayStart = Date.UTC(year, month, date) - DHAKA_OFFSET_MS;
  const next = dayStart + DAY_MS;
  const day = `${year}-${String(month + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
  return {
    day,
    resetAt: next,
    resetAtSeconds: Math.floor(next / 1000),
  };
}

export function quotaKey(userId: string, day: string): string {
  return `buildx:quota:${userId}:${day}`;
}

export function quotaAttemptKey(
  userId: string,
  day: string,
  attemptId: string,
): string {
  return `buildx:quota:${userId}:${day}:attempt:${attemptId}`;
}

const RESERVE_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if redis.call('EXISTS', KEYS[2]) == 1 then
  return {used, 1, 1}
end
local limit = tonumber(ARGV[1])
if used >= limit then
  return {used, 0, 0}
end
local nextUsed = redis.call('INCR', KEYS[1])
if nextUsed == 1 then
  redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[2]))
end
redis.call('SET', KEYS[2], 'reserved', 'EXAT', tonumber(ARGV[2]))
return {nextUsed, 1, 0}
`;

const SETTLE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL')
return 1
`;

type RawTuple = [number | string, number | string, number | string];

function normalizeTuple(raw: unknown): RawTuple {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new QuotaServiceUnavailableError(
      "Quota reservation returned an unexpected response.",
    );
  }
  return [raw[0] as number | string, raw[1] as number | string, raw[2] as number | string];
}

function toInt(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new QuotaServiceUnavailableError(
      "Quota reservation returned a non-numeric counter.",
    );
  }
  return parsed;
}

function snapshotFor(
  used: number,
  limit: number,
  resetAt: number,
): QuotaSnapshot {
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetAt,
  };
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof QuotaExceededError ||
    error instanceof QuotaServiceUnavailableError
  );
}

export function createQuotaService(backend: QuotaBackend): QuotaService {
  const now = backend.now ?? Date.now;
  const limit = backend.limit ?? DAILY_MODEL_REQUEST_LIMIT;

  async function read(userId: string): Promise<QuotaSnapshot> {
    const window = quotaWindow(now());
    try {
      const raw = await backend.redis.get<number | string | null>(
        quotaKey(userId, window.day),
      );
      const used = raw == null ? 0 : toInt(raw);
      return snapshotFor(used, limit, window.resetAt);
    } catch (error) {
      if (isQuotaError(error)) throw error;
      throw new QuotaServiceUnavailableError(
        "Unable to read the daily AI request quota.",
        error,
      );
    }
  }

  async function reserve(
    userId: string,
    attemptId: string,
  ): Promise<QuotaReservation> {
    const window = quotaWindow(now());
    let tuple: RawTuple;
    try {
      const raw = await backend.redis.eval<unknown>(
        RESERVE_SCRIPT,
        [
          quotaKey(userId, window.day),
          quotaAttemptKey(userId, window.day, attemptId),
        ],
        [String(limit), String(window.resetAtSeconds)],
      );
      tuple = normalizeTuple(raw);
    } catch (error) {
      if (isQuotaError(error)) throw error;
      throw new QuotaServiceUnavailableError(
        "Unable to reserve a daily AI request.",
        error,
      );
    }

    const used = toInt(tuple[0]);
    const allowed = toInt(tuple[1]) === 1;
    const duplicate = toInt(tuple[2]) === 1;
    const snapshot = snapshotFor(used, limit, window.resetAt);
    if (!allowed) throw new QuotaExceededError(snapshot);
    return { attemptId, allowed, duplicate, snapshot };
  }

  async function transition(
    userId: string,
    attemptId: string,
    state: string,
  ): Promise<void> {
    const window = quotaWindow(now());
    try {
      await backend.redis.eval<unknown>(
        SETTLE_SCRIPT,
        [quotaAttemptKey(userId, window.day, attemptId)],
        [state],
      );
    } catch (error) {
      if (isQuotaError(error)) throw error;
      throw new QuotaServiceUnavailableError(
        "Unable to update the AI request reservation.",
        error,
      );
    }
  }

  return {
    read,
    reserve,
    markDispatched: (userId, attemptId) =>
      transition(userId, attemptId, "dispatched"),
    settle: (userId, attemptId, result) =>
      transition(userId, attemptId, `settled:${result}`),
  };
}

let defaultService: QuotaService | undefined;
let defaultRedis: Redis | undefined;

function getRedis(): Redis {
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  if (!url || !token) {
    throw new QuotaServiceUnavailableError(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required to enforce the daily AI quota.",
    );
  }
  defaultRedis ??= new Redis({ url, token });
  return defaultRedis;
}

export function getQuotaService(): QuotaService {
  if (!defaultService) {
    defaultService = createQuotaService({
      redis: {
        eval: (script, keys, args) => getRedis().eval(script, keys, args),
        get: (key) => getRedis().get(key),
      },
    });
  }
  return defaultService;
}

export function readConfiguredQuota(userId: string): Promise<QuotaSnapshot> {
  return getQuotaService().read(userId);
}

/** Test hook: drop the memoized client/service after env changes. */
export function resetQuotaServiceForTests(): void {
  defaultService = undefined;
  defaultRedis = undefined;
}
