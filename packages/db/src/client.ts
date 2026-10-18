import { sql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { neon as neonHttp } from "@neondatabase/serverless";
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
 * ## Cloudflare Workers I/O isolation
 *
 * Cloudflare Workers enforce strict I/O context isolation: any socket or
 * WebSocket connection created inside one request handler CANNOT be used by a
 * different request handler (you get "Cannot perform I/O on behalf of a
 * different request"). The `@neondatabase/serverless` WebSocket Pool holds an
 * open WS connection that is bound to the request context that created it, so
 * caching a `NeonPool` on `globalThis` and reusing it across requests is
 * illegal in Workers.
 *
 * The fix: in Cloudflare Workers (detected via `OPENNEXT_CLOUDFLARE=true` or
 * `NEXT_RUNTIME=edge`), use the **HTTP driver** (`drizzle-orm/neon-http` +
 * `neon()` from `@neondatabase/serverless`) instead. The HTTP client fires a
 * new `fetch()` per query — stateless, no pooled sockets, safe to cache on
 * `globalThis` across requests. Transactions that require session-level state
 * (advisory locks, `FOR UPDATE SKIP LOCKED`) are not available through the
 * HTTP driver; in that case callers MUST pass `driver: "neon"` explicitly with
 * a fresh pool to acknowledge the trade-off.
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
   *  - 'node-pg' — TCP pool (Node.js / Hyperdrive)
   *  - 'neon'    — WebSocket Pool (node.js-only; NOT safe to cache in Cloudflare Workers)
   *  - 'neon-http' — HTTP fetch per query (stateless; safe in Cloudflare Workers)
   */
  driver?: "node-pg" | "neon" | "neon-http";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

const globalForDb = globalThis as unknown as { __BUILDX_DB__?: Db };

/**
 * Detect whether we are running inside a Cloudflare Worker (OpenNext runtime).
 * In that context the `NeonPool` WebSocket driver is forbidden for reuse across
 * requests; the stateless HTTP driver must be used instead.
 */
function isCloudflareWorker(): boolean {
  if (typeof process !== "undefined") {
    if (process.env.OPENNEXT_CLOUDFLARE === "true" || process.env.NEXT_RUNTIME === "edge") {
      return true;
    }
  }
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    return true;
  }
  if (typeof globalThis !== "undefined" && Boolean((globalThis as { WebSocketPair?: unknown }).WebSocketPair)) {
    return true;
  }
  return false;
}

/**
 * Choose the correct driver for the current runtime and connection string.
 *
 * Decision table (first match wins):
 *  1. Explicit `driver` option → honour it.
 *  2. `BUILDX_DB_DRIVER` env var → honour it.
 *  3. Hyperdrive URL or `hyperdrive` in connection string → node-pg (TCP).
 *  4. Cloudflare Worker + Neon host → neon-http (HTTP, request-safe).
 *  5. Neon host in Node.js → neon (WebSocket Pool).
 *  6. Anything else → node-pg.
 */
function resolveDriver(
  connectionString: string,
  driverOption?: "node-pg" | "neon" | "neon-http",
): "node-pg" | "neon" | "neon-http" {
  if (driverOption) return driverOption;

  const envDriver = process.env.BUILDX_DB_DRIVER?.toLowerCase();
  if (envDriver === "neon-http") return "neon-http";
  if (envDriver === "neon") return "neon";
  if (envDriver === "node-pg" || envDriver === "pg") return "node-pg";

  // Cloudflare Hyperdrive connections use standard TCP socket proxy
  if (process.env.HYPERDRIVE_URL || connectionString.includes("hyperdrive")) {
    return "node-pg";
  }

  const isNeonHost = connectionString.includes(".neon.tech");

  // In Cloudflare Workers, the WebSocket Pool is bound to the creating request's
  // I/O context and cannot be reused across requests. Use the HTTP driver instead.
  if (isCloudflareWorker() && isNeonHost) {
    return "neon-http";
  }

  // In Node.js, the WebSocket Pool is safe to cache as a process-wide singleton.
  if (isNeonHost) {
    return "neon";
  }

  return "node-pg";
}

function buildDb(
  connectionString: string,
  driver: "node-pg" | "neon" | "neon-http",
): Db {
  switch (driver) {
    case "neon-http": {
      // The `neon()` HTTP client issues one HTTPS fetch per query. It has no
      // persistent connection so it is completely safe to cache on `globalThis`
      // and reuse across Cloudflare Worker requests. Transactions work but are
      // limited to a single round-trip (no advisory locks or session state).
      const sql = neonHttp(connectionString);
      return drizzleNeonHttp(sql, { schema }) as unknown as Db;
    }
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
 * The database client. In Node.js (dev / long-lived server) this is a
 * process-wide singleton (important: hot reload must not open a new Pool per
 * module instance). In Cloudflare Workers the singleton uses the stateless HTTP
 * driver so it can safely be shared across requests.
 *
 * Real Postgres — real transactions, `FOR UPDATE SKIP LOCKED` and advisory
 * locks are available on the node-pg and neon (WebSocket) drivers. The
 * neon-http driver supports transactions but not session-level constructs
 * (advisory locks require a persistent connection).
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
 * Advisory locks require a persistent connection; they are unavailable through
 * the Neon HTTP driver. Call `getDb({ driver: "neon" })` or `getDb({ driver:
 * "node-pg" })` explicitly when you need advisory locking.
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