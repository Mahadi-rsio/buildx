import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { dailyRequests, runs, usageSessions } from "./schema";

/**
 * Quota + usage accounting (arcetecture.md §3.5, plan phase 4). Counters are
 * enforced in the database, never in application memory, so concurrent requests
 * cannot overshoot.
 */

/** A workspace with no activity is archived after this many minutes. */
export const FREE_IDLE_MINUTES = 5;
/** Requests per user per Dhaka day. */
export const DAILY_REQUEST_LIMIT = 30;
/** Machine CPU-hours per user per calendar month. */
export const MONTHLY_CPU_HOURS = 5;
/** Hard caps for a single agent run. */
export const MAX_STEPS = 25;
export const MAX_RUN_MS = 10 * 60 * 1000;

const DHAKA_TZ = "Asia/Dhaka";
/** Bangladesh Standard Time is a fixed UTC+6 offset (no DST). */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** The current calendar day in Asia/Dhaka as `YYYY-MM-DD`. */
export function dhakaDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DHAKA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The instant of the next midnight in Asia/Dhaka (the daily quota reset). */
export function nextDhakaReset(date: Date = new Date()): Date {
  const [year, month, day] = dhakaDay(date).split("-").map(Number);
  const nextMidnightUtc = Date.UTC(year, month - 1, day + 1) - DHAKA_OFFSET_MS;
  return new Date(nextMidnightUtc);
}

/**
 * Atomically consume one daily request. Returns the new count when the request
 * is allowed, or `null` when the user is already at the limit. The `WHERE` on
 * the conflict update is what makes 100 concurrent calls stop at exactly 30.
 */
export async function consumeDailyRequest(
  db: Db,
  userId: string,
  day: string = dhakaDay(),
): Promise<number | null> {
  const rows = await db
    .insert(dailyRequests)
    .values({ userId, day, count: 1 })
    .onConflictDoUpdate({
      target: [dailyRequests.userId, dailyRequests.day],
      set: {
        count: sql`${dailyRequests.count} + 1`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${dailyRequests.count} < ${DAILY_REQUEST_LIMIT}`,
    })
    .returning({ count: dailyRequests.count });

  return rows[0]?.count ?? null;
}

/** Give back a consumed request after a server-side failure. Never below zero. */
export async function refundDailyRequest(
  db: Db,
  userId: string,
  day: string = dhakaDay(),
): Promise<void> {
  await db
    .update(dailyRequests)
    .set({
      count: sql`GREATEST(${dailyRequests.count} - 1, 0)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(dailyRequests.userId, userId), eq(dailyRequests.day, day)),
    );
}

/** Current count for the day (0 when the row does not exist yet). */
export async function dailyRequestCount(
  db: Db,
  userId: string,
  day: string = dhakaDay(),
): Promise<number> {
  const rows = await db
    .select({ count: dailyRequests.count })
    .from(dailyRequests)
    .where(and(eq(dailyRequests.userId, userId), eq(dailyRequests.day, day)));
  return rows[0]?.count ?? 0;
}

/** Open a usage session when a machine starts; returns its id. */
export async function openUsageSession(
  db: Db,
  input: { userId: string; workspaceId: string; machineId?: string },
): Promise<string> {
  const rows = await db
    .insert(usageSessions)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      machineId: input.machineId,
    })
    .returning({ id: usageSessions.id });
  return rows[0].id;
}

/** Close an open usage session; returns false when it was already closed. */
export async function closeUsageSession(
  db: Db,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .update(usageSessions)
    .set({ endedAt: sql`now()` })
    .where(and(eq(usageSessions.id, sessionId), isNull(usageSessions.endedAt)))
    .returning({ id: usageSessions.id });
  return rows.length === 1;
}

/**
 * Machine CPU-seconds used this calendar month: the sum of closed sessions plus
 * the elapsed time of any still-open session.
 */
export async function monthlyCpuSecondsUsed(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({
      seconds: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(${usageSessions.endedAt}, now()) - ${usageSessions.startedAt}))), 0)`,
    })
    .from(usageSessions)
    .where(
      and(
        eq(usageSessions.userId, userId),
        sql`${usageSessions.startedAt} >= date_trunc('month', now())`,
      ),
    );
  return Number(rows[0]?.seconds ?? 0);
}

/** Whether the user still has monthly CPU budget for another machine. */
export async function hasCpuBudget(db: Db, userId: string): Promise<boolean> {
  const used = await monthlyCpuSecondsUsed(db, userId);
  return used < MONTHLY_CPU_HOURS * 3600;
}

/** Number of runs currently in the `running` state for this user. */
export async function countActiveRuns(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.userId, userId), eq(runs.status, "running")));
  return rows.length;
}

/** At most one active run per user (plan phase 4). */
export async function canStartRun(db: Db, userId: string): Promise<boolean> {
  return (await countActiveRuns(db, userId)) === 0;
}
