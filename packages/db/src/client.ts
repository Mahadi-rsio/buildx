import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Create a Drizzle client over a `pg` Pool. Accepts a caller-supplied pool so
 * tests / scripts / migrations can own their own; the default path caches a
 * singleton on `globalThis` so Next.js hot reload never exhausts connections.
 */
export interface DbClientOptions {
  /** Existing pool to wrap. When omitted, a Pool is created from DATABASE_URL. */
  pool?: Pool;
  /** Connection string (used when `pool` is omitted). Falls back to env. */
  connectionString?: string;
  /** When true, always build a fresh client instead of caching on globalThis. */
  fresh?: boolean;
}

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __BUILDX_DB__?: Db };

/**
 * The database client. In Next.js dev this is a process-wide singleton
 * (important: hot reload must not open a new Pool per module instance).
 * Real Postgres — real transactions, `FOR UPDATE SKIP LOCKED` and advisory
 * locks are all available on this handle.
 */
export function getDb(options: DbClientOptions = {}): Db {
  if (!options.fresh && globalForDb.__BUILDX_DB__) {
    return globalForDb.__BUILDX_DB__;
  }

  const connectionString =
    options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const pool = options.pool ?? new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  if (!options.fresh) globalForDb.__BUILDX_DB__ = db;
  return db;
}

export { schema };
export * from "./schema";

/** Re-export node-postgres bits callers occasionally need (e.g. sql template). */
export { Pool } from "pg";
export { sql } from "drizzle-orm";

/**
 * Take a Postgres advisory lock for the duration of `fn`. Only one process ever
 * holds a given lock id, so background jobs guarded this way are safe to run
 * from multiple instances simultaneously (arcetecture.md §9, plan phase 9).
 */
export async function withAdvisoryLock<T>(
  db: Db,
  lockId: number,
  fn: () => Promise<T>,
): Promise<T> {
  await db.execute(sql`SELECT pg_advisory_lock(${lockId})`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`);
  }
}