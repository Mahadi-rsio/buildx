import { readdir, readFile, stat } from "node:fs/promises";
import { resolveWorkspacePath } from "@buildx/sandbox";
import { getRun } from "@/lib/store";
import type { FileEntry, FileContentResponse, FilesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_PREVIEW_BYTES = 1_000_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `GET /api/workspaces/:id/files?path=` — list a directory inside the run's
 * workspace, or return a single file's contents when `path` names a file
 * (arcetecture.md §6). Traversal outside the workspace is rejected.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }

  const url = new URL(request.url);
  const rel = url.searchParams.get("path")?.trim() || ".";

  let target: string;
  try {
    target = resolveWorkspacePath(run.workspaceDir, rel);
  } catch (error) {
    return Response.json({ error: "invalid_path", message: message(error) }, { status: 400 });
  }

  let stats;
  try {
    stats = await stat(target);
  } catch {
    return Response.json({ error: "not_found", path: rel }, { status: 404 });
  }

  if (stats.isFile()) {
    if (stats.size > MAX_PREVIEW_BYTES) {
      return Response.json(
        { error: "file_too_large", path: rel, size: stats.size },
        { status: 413 },
      );
    }
    const buffer = await readFile(target);
    const binary = buffer.includes(0);
    const response: FileContentResponse = {
      path: rel,
      type: "file",
      content: binary ? "" : buffer.toString("utf8"),
      size: stats.size,
      binary,
    };
    return Response.json(response);
  }

  const dirents = await readdir(target, { withFileTypes: true });
  const parent = rel.replace(/[./]+$/, "");
  const entries: FileEntry[] = dirents
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .map(
      (entry): FileEntry => ({
        name: entry.name,
        path: parent ? `${parent}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      }),
    )
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );

  const response: FilesResponse = { path: rel, type: "dir", entries };
  return Response.json(response);
}
