import { sql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import * as schema from "./schema";

/**
 * Create a Drizzle client over a `pg` Pool, `@neondatabase/serverless` Pool,
 * or the Neon HTTP driver. Accepts a caller-supplied pool so tests / scripts /
 * migrations can own their own; the default path caches a singleton on
 * `globalThis` so Next.js hot reload never exhausts connections.
 *
 * The default driver is a pooled connection (Neon WebSocket pool for Neon
 * hosts, `pg` TCP pool otherwise). Both support real transactions, `FOR UPDATE
 * SKIP LOCKED`, and advisory locks, which the run manager depends on. The
 * stateless Neon HTTP driver is intentionally not used: it cannot hold a
 * session, so leases and workspace locks would be unsafe.
 */
export interface DbClientOptions {
  /** Existing pool to wrap. When omitted, a Pool is created from DATABASE_URL. */
  pool?: PgPool | NeonPool;
  /** Connection string (used when `pool` is omitted). Falls back to env. */
  connectionString?: string;
  /** When true, always build a fresh client instead of caching on globalThis. */
  fresh?: boolean;
  /**
   * Explicit driver choice:
   *  - 'node-pg' — TCP pool (`pg`), for local Postgres and tests.
   *  - 'neon'    — Neon WebSocket pool, for Neon hosts.
   */
  driver?: "node-pg" | "neon";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

const globalForDb = globalThis as unknown as { __BUILDX_DB__?: Db };

/**
 * Choose the driver for a connection string.
 *
 * Decision table (first match wins):
 *  1. Explicit `driver` option → honour it.
 *  2. `BUILDX_DB_DRIVER` env var → honour it (`neon`, `node-pg`/`pg`).
 *  3. Neon host → neon (WebSocket pool).
 *  4. Anything else → node-pg.
 *
 * `neon-http` is deliberately rejected: the run manager needs session-level
 * SQL (transactions, `FOR UPDATE SKIP LOCKED`, advisory locks).
 */
function resolveDriver(
  connectionString: string,
  driverOption?: "node-pg" | "neon",
): "node-pg" | "neon" {
  if (driverOption) return driverOption;

  const envDriver = process.env.BUILDX_DB_DRIVER?.toLowerCase();
  if (envDriver === "neon") return "neon";
  if (envDriver === "node-pg" || envDriver === "pg") return "node-pg";
  if (envDriver === "neon-http") {
    throw new Error(
      'BUILDX_DB_DRIVER=neon-http is not supported: the run manager needs a pooled connection. Use "neon" or "node-pg".',
    );
  }

  if (connectionString.includes(".neon.tech")) return "neon";
  return "node-pg";
}

function buildDb(connectionString: string, driver: "node-pg" | "neon"): Db {
  switch (driver) {
    case "neon": {
      // WebSocket-based pool. Safe as a Node.js process-wide singleton but MUST
      // NOT be cached in Cloudflare Workers (use neon-http there).
      const pool = new NeonPool({ connectionString });
      return drizzleNeon(pool, { schema }) as unknown as Db;
    }
    case "node-pg":
    default: {
      const pool = new PgPool({ connectionString });
      return drizzleNodePg(pool, { schema }) as unknown as Db;
    }
  }
}

/**
 * The database client. A process-wide singleton in the Node.js server
 * (important: hot reload must not open a new Pool per module instance).
 *
 * Both drivers are pooled, so transactions, `FOR UPDATE SKIP LOCKED`, and
 * advisory locks all work.
 */
export function getDb(options: DbClientOptions = {}): Db {
  if (!options.fresh && globalForDb.__BUILDX_DB__) {
    return globalForDb.__BUILDX_DB__;
  }

  const connectionString =
    options.connectionString ?? process.env.DATABASE_URL;
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
    const driver = resolveDriver(connectionString!, options.driver);
    db = buildDb(connectionString!, driver);
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
 *
 * Both supported drivers keep a pooled connection, so the lock is held for the
 * duration of `fn`.
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