import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspacePath } from "@buildx/sandbox";
import { structuredPatch } from "diff";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffResponse,
} from "./types";

export const MAX_DIFF_BYTES = 200_000;
export const DIFF_CONTEXT = 3;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "build",
  ".turbo",
]);

/**
 * Recursively list relative file paths inside the workspace, skipping ignored
 * directories. `out` accumulates so a snapshot can be built without materializing.
 */
async function walk(
  root: string,
  rel: string,
  out: { path: string; size: number; mtime: number }[],
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of dirents) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(root, path));
      out.push({ path, size: info.size, mtime: info.mtimeMs });
    } catch {
      // Ignore files that raced away (e.g. sandbox teardown).
    }
  }
}

/** Shape of the run-start baseline snapshot (relative path → original text). */
export type Baseline = Map<string, string>;

/** Capture the current workspace contents as a baseline. */
export async function captureWorkspaceSnapshot(root: string): Promise<Baseline> {
  const files: { path: string; size: number; mtime: number }[] = [];
  await walk(root, "", files);
  const baseline: Baseline = new Map();
  for (const file of files) {
    if (file.size > MAX_DIFF_BYTES) continue;
    try {
      const buffer = await readFile(join(root, file.path));
      if (buffer.includes(0)) continue;
      baseline.set(file.path, buffer.toString("utf8"));
    } catch {
      // Skip files we can no longer read.
    }
  }
  return baseline;
}

function toLine(coded: string): DiffLine {
  if (coded.startsWith("+")) return { type: "add", text: coded.slice(1) };
  if (coded.startsWith("-")) return { type: "del", text: coded.slice(1) };
  return { type: "ctx", text: coded.startsWith(" ") ? coded.slice(1) : coded };
}

function toHunk(oldStr: string, newStr: string): DiffHunk[] | null {
  const patch = structuredPatch("a", "b", oldStr, newStr, "", "", {
    context: DIFF_CONTEXT,
  });
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map(toLine),
  }));
}

/**
 * Compute a per-file unified diff between the run-start baseline and the
 * current workspace. Unchanged files are skipped; binary and oversized files are
 * reported with an empty hunk list so the UI can render a notice instead.
 */
export async function compareAgainstBaseline(
  root: string,
  baseline: Baseline,
): Promise<DiffResponse> {
  const current: { path: string; size: number; mtime: number }[] = [];
  await walk(root, "", current);

  const seen = new Set<string>();
  const files: DiffFile[] = [];

  for (const file of current) {
    seen.add(file.path);
    const original = baseline.get(file.path);
    let buffer: Buffer;
    try {
      buffer = await readFile(join(root, file.path));
    } catch {
      continue;
    }
    const binary = buffer.includes(0) || file.size > MAX_DIFF_BYTES;

    if (original === undefined) {
      // Added file.
      const text = binary ? "" : buffer.toString("utf8");
      const hunks = binary ? [] : (toHunk("", text) ?? []);
      const additions = binary
        ? 0
        : hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === "add").length, 0);
      files.push({
        path: file.path,
        status: "A",
        additions,
        deletions: 0,
        hunks,
        binary,
        size: file.size,
        mtime: file.mtime,
      });
      continue;
    }

    if (binary) {
      files.push({
        path: file.path,
        status: "M",
        additions: 0,
        deletions: 0,
        hunks: [],
        binary,
        size: file.size,
        mtime: file.mtime,
      });
      continue;
    }

    const currentText = buffer.toString("utf8");
    if (currentText === original) continue;

    const hunks = toHunk(original, currentText) ?? [];
    const additions = hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
      0,
    );
    const deletions = hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "del").length,
      0,
    );
    files.push({
      path: file.path,
      status: "M",
      additions,
      deletions,
      hunks,
      size: file.size,
      mtime: file.mtime,
    });
  }

  for (const [path, original] of baseline) {
    if (seen.has(path)) continue;
    const hunks = toHunk(original, "") ?? [];
    const deletions = hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "del").length,
      0,
    );
    files.push({
      path,
      status: "D",
      additions: 0,
      deletions,
      hunks,
    });
  }

  files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));

  const unchanged = Math.max(0, current.length - files.length);
  const skipped = files.filter((f) => f.binary && f.hunks.length === 0).length;
  return { files, skipped, unchanged };
}

/**
 * Resolve a relative workspace path, reusing `resolveWorkspacePath` so the same
 * safety rules are enforced as the files API. Throws on traversal.
 */
export function resolveWorkspaceFile(root: string, rel: string): string {
  return resolveWorkspacePath(root, rel);
}