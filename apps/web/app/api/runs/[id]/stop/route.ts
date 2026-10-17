import { isTerminalStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { appendEvent, finishRun, toRunSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * `POST /api/runs/:id/stop` — abort the loop. A queued run is cancelled
 * immediately; a running one stops as soon as `runTask` observes the abort.
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

  run.controller.abort();

  if (run.status === "queued") {
    const message = "stopped before the agent started";
    await appendEvent(run, {
      type: "status",
      data: { status: "cancelled", message },
      ts: Date.now(),
    });
    await finishRun(run, "cancelled", message);
  }

  return Response.json(toRunSummary(run));
}
