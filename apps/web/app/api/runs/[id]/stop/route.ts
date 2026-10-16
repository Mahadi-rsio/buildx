import { isTerminalStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { appendEvent, finishRun, getRun, toRunSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * `POST /api/runs/:id/stop` — abort the loop. A queued run is cancelled
 * immediately; a running one stops as soon as `runTask` observes the abort.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await getCurrentUser())) return unauthorized();

  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }

  if (isTerminalStatus(run.status)) {
    return Response.json(toRunSummary(run));
  }

  run.controller.abort();

  if (run.status === "queued") {
    const message = "stopped before the agent started";
    appendEvent(run, {
      type: "status",
      data: { status: "cancelled", message },
      ts: Date.now(),
    });
    finishRun(run, "cancelled", message);
  }

  return Response.json(toRunSummary(run));
}
