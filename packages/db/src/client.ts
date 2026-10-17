import { sql } from "drizzle-orm";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon, type NeonDatabase } from "drizzle-orm/neon-serverless";
import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import * as schema from "./schema";

/**
 * Create a Drizzle client over a `pg` Pool or `@neondatabase/serverless` Pool.
 * Accepts a caller-supplied pool so tests / scripts / migrations can own their own;
 * the default path caches a singleton on `globalThis` so Next.js hot reload never exhausts connections.
 */
export interface DbClientOptions {
  /** Existing pool to wrap. When omitted, a Pool is created from DATABASE_URL. */
  pool?: PgPool | NeonPool;
  /** Connection string (used when `pool` is omitted). Falls back to env. */
  connectionString?: string;
  /** When true, always build a fresh client instead of caching on globalThis. */
  fresh?: boolean;
  /** Explicit driver choice ('neon' uses WebSocket; 'node-pg' uses TCP/Hyperdrive). */
  driver?: "node-pg" | "neon";
}

export type Db = NodePgDatabase<typeof schema> | NeonDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __BUILDX_DB__?: Db };

function shouldUseNeonDriver(connectionString: string, driverOption?: "node-pg" | "neon"): boolean {
  if (driverOption === "neon") return true;
  if (driverOption === "node-pg") return false;
  const envDriver = process.env.BUILDX_DB_DRIVER?.toLowerCase();
  if (envDriver === "neon") return true;
  if (envDriver === "node-pg" || envDriver === "pg") return false;

  // Cloudflare Hyperdrive connections use standard TCP socket proxy
  if (process.env.HYPERDRIVE_URL || connectionString.includes("hyperdrive")) {
    return false;
  }

  // Neon WebSocket driver for Cloudflare Workers / browser-like environments
  const isCloudflare =
    typeof process !== "undefined" &&
    (process.env.OPENNEXT_CLOUDFLARE === "true" || process.env.NEXT_RUNTIME === "edge");
  const isNeonHost = connectionString.includes(".neon.tech");

  return Boolean(isCloudflare && isNeonHost);
}

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
    options.connectionString ??
    process.env.HYPERDRIVE_URL ??
    process.env.DATABASE_URL;
  if (!connectionString && !options.pool) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  let db: Db;
  if (options.pool) {
    if (options.pool instanceof NeonPool) {
      db = drizzleNeon(options.pool, { schema }) as unknown as Db;
    } else {
      db = drizzleNodePg(options.pool as PgPool, { schema }) as unknown as Db;
    }
  } else {
    const useNeon = shouldUseNeonDriver(connectionString!, options.driver);
    if (useNeon) {
      const pool = new NeonPool({ connectionString: connectionString! });
      db = drizzleNeon(pool, { schema }) as unknown as Db;
    } else {
      const pool = new PgPool({ connectionString: connectionString! });
      db = drizzleNodePg(pool, { schema }) as unknown as Db;
    }
  }

  if (!options.fresh) globalForDb.__BUILDX_DB__ = db;
  return db;
}

export { schema };
export * from "./schema";

/** Re-export node-postgres bits callers occasionally need (e.g. sql template). */
export { Pool } from "pg";
export { sql } from "drizzle-orm";
/** Query helpers for building where clauses on the shared schema objects. */
export { and, asc, desc, eq, gt, inArray, isNull, like, not, or } from "drizzle-orm";

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