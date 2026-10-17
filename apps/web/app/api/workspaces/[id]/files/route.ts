import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { getRun, getRunByWorkspaceId } from "@/lib/store";
import { sourceForRun } from "@/lib/workspace-source";
import type { FileContentResponse, FilesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_PREVIEW_BYTES = 1_000_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `GET /api/workspaces/:id/files?path=` — list a directory inside the run's
 * workspace, or return a single file's contents when `path` names a file
 * (arcetecture.md §6). Reads through the run's `WorkspaceSource` so it works
 * for local and box sandboxes alike. Traversal is rejected.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await getCurrentUser())) return unauthorized();

  const { id } = await params;
  const run = getRun(id) ?? getRunByWorkspaceId(id);
  if (!run) {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }

  const url = new URL(request.url);
  const rel = url.searchParams.get("path")?.trim() || ".";
  const source = sourceForRun(run);

  // Resolve first so traversal attempts fail with a 400 regardless of kind.
  try {
    source.resolve(rel);
  } catch (error) {
    return Response.json(
      { error: "invalid_path", message: message(error) },
      { status: 400 },
    );
  }

  const folder = rel === "." || rel === "" ? "" : rel.replace(/\/+$/, "");
  let type: "file" | "dir" | null;
  try {
    type = (await source.stat(folder))?.type ?? null;
  } catch {
    type = null;
  }
  if (type === "file") {
    try {
      const read = await source.readFile(folder);
      if (read.size > MAX_PREVIEW_BYTES) {
        return Response.json(
          { error: "file_too_large", path: folder, size: read.size },
          { status: 413 },
        );
      }
      const response: FileContentResponse = {
        path: folder,
        type: "file",
        content: read.binary ? "" : read.content,
        size: read.size,
        binary: read.binary,
      };
      return Response.json(response);
    } catch (error) {
      return Response.json(
        { error: "read_failed", message: message(error) },
        { status: 500 },
      );
    }
  }

  try {
    const entries = await source.listDir(folder);
    const response: FilesResponse = { path: rel, type: "dir", entries };
    return Response.json(response);
  } catch {
    return Response.json(
      { error: "not_found", path: rel },
      { status: 404 },
    );
  }
}
