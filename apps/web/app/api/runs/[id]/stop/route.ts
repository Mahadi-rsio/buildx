import { isTerminalStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { cancelRun, refreshRun, toRunSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * `POST /api/runs/:id/stop` — durable, cross-instance cancellation. Persists
 * the cancel flag on the run row (`cancelled_at`) so whichever worker holds
 * the lease observes it and stops the loop, then aborts the process-local
 * AbortController in case this process is the one executing it. A queued run
 * is cancelled once the worker claims it; a running one stops as soon as the
 * agent loop sees the abort.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const { id } = await params;
  const owned = await findOwnedRun(id, user.id);
  if (!owned) return notFound(id);

  // Re-read durable fields from Postgres: the cached object may predate a
  // terminal transition or lease handoff in another instance, and a stale owner
  // must not decide the request here.
  const run = (await refreshRun(id)) ?? owned;

  if (isTerminalStatus(run.status)) {
    return Response.json(toRunSummary(run));
  }

  await cancelRun(run, "stopped by the user");

  // Re-read so the response reflects the persisted state even when the
  // cancelling process isn't the one executing the run.
  const refreshed = (await refreshRun(run.id)) ?? run;
  return Response.json(toRunSummary(refreshed));
}