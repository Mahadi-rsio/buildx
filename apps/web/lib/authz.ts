import { getRun, getRunByWorkspaceId, type StoredRun } from "./store";

/**
 * Multi-tenant guard for run/workspace routes. A run id (or workspace id) that
 * belongs to somebody else must be indistinguishable from one that does not
 * exist, so callers always answer 404 and never leak that a foreign resource is
 * real.
 */

/** Standard 404 payload — used for missing *and* foreign resources. */
export function notFound(id: string): Response {
  return Response.json({ error: "not_found", id }, { status: 404 });
}

/**
 * Resolve a run by its own id or by its workspace id, but only when it belongs
 * to `userId`. Returns `undefined` for both "no such resource" and "someone
 * else's resource".
 */
export async function findOwnedRun(
  id: string,
  userId: string,
): Promise<StoredRun | undefined> {
  const run = (await getRun(id)) ?? (await getRunByWorkspaceId(id));
  if (!run || run.userId !== userId) return undefined;
  return run;
}
