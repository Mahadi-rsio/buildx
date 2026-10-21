import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import {
  captureWorkspaceSnapshot,
  compareAgainstBaseline,
} from "@/lib/workspace-fs";
import { sourceForRun } from "@/lib/workspace-source";
import type { DiffResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const DIFF_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 5_000;

class TimeoutError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`timed out after ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `GET /api/workspaces/:id/diff` — unified diff between the run-start baseline
 * snapshot and the workspace's current contents (arcetecture.md §6). The
 * baseline is captured lazily for older runs that predate snapshotting. Reads
 * through the user's persistent Box workspace.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  const source = sourceForRun(run);
  try {
    const response = await withTimeout(
      (async () => {
        if (!run.runtime.baseline) {
          run.runtime.baseline = await captureWorkspaceSnapshot(source);
        }
        return compareAgainstBaseline(source, run.runtime.baseline);
      })(),
      DIFF_TIMEOUT_MS,
    );
    return Response.json(response);
  } catch (error) {
    if (error instanceof TimeoutError) {
      const fallbackFiles = await withTimeout(
        source.listFiles(),
        LIST_TIMEOUT_MS,
      ).catch(() => []);
      const body: DiffResponse = {
        files: [],
        unchanged: 0,
        skipped: 0,
        fallbackFiles,
      };
      return Response.json(
        {
          ...body,
          error: "diff_timeout",
          message:
            "The diff is taking too long. Showing the workspace file list instead.",
        },
        { status: 504 },
      );
    }
    return Response.json(
      { error: "diff_failed", message: message(error) },
      { status: 500 },
    );
  }
}