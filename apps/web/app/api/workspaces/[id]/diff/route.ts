import { getRun } from "@/lib/store";
import {
  captureWorkspaceSnapshot,
  compareAgainstBaseline,
} from "@/lib/workspace-fs";
import type { DiffResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `GET /api/workspaces/:id/diff` — unified diff between the run-start baseline
 * snapshot and the workspace's current contents (arcetecture.md §6). The
 * baseline is captured lazily for older runs that predate snapshotting.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }

  try {
    if (!run.baseline) {
      run.baseline = await captureWorkspaceSnapshot(run.workspaceDir);
    }
    const response: DiffResponse = await compareAgainstBaseline(
      run.workspaceDir,
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