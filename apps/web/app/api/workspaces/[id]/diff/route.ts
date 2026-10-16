import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { getRun } from "@/lib/store";
import {
  captureWorkspaceSnapshot,
  compareAgainstBaseline,
} from "@/lib/workspace-fs";
import { sourceForRun } from "@/lib/workspace-source";
import type { DiffResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `GET /api/workspaces/:id/diff` — unified diff between the run-start baseline
 * snapshot and the workspace's current contents (arcetecture.md §6). The
 * baseline is captured lazily for older runs that predate snapshotting. Reads
 * through the run's `WorkspaceSource` so it works for local and remote
 * (Fly daemon) sandboxes alike.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await getCurrentUser())) return unauthorized();

  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }

  try {
    const source = sourceForRun(run);
    if (!run.baseline) {
      run.baseline = await captureWorkspaceSnapshot(source);
    }
    const response: DiffResponse = await compareAgainstBaseline(
      source,
      run.baseline,
    );
    return Response.json(response);
  } catch (error) {
    return Response.json(
      { error: "diff_failed", message: message(error) },
      { status: 500 },
    );
  }
}