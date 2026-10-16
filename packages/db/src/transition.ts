import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client";

/**
 * Atomic status transition: a single conditional UPDATE that only succeeds when
 * the row is currently in `from`. Returns whether the row moved. This is the
 * only way status changes happen — two concurrent callers can never both win,
 * which is what makes `ensureRunning`/`archive` safe (plan.md phases 4 & 7).
 */
export async function transition(
  db: Db,
  table: PgTable,
  id: string,
  from: string,
  to: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE ${table}
    SET status = ${to}, updated_at = now()
    WHERE id = ${id} AND status = ${from}
    RETURNING id
  `);
  return result.rowCount === 1;
}
