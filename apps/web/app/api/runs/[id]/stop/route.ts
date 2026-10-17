import { isTerminalStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { cancelRun, getRun, toRunSummary } from "@/lib/store";

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
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  if (isTerminalStatus(run.status)) {
    return Response.json(toRunSummary(run));
  }

  const newlyRequested = await cancelRun(
    run,
    "stopped by the user",
  );
  void newlyRequested;

  // Re-read so the response reflects the persisted state even when the
  // cancelling process isn't the one executing the run.
  const refreshed = (await getRun(run.id)) ?? run;
  return Response.json(toRunSummary(refreshed));
}