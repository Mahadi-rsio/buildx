import { structuredPatch } from "diff";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffResponse,
} from "./types";
import type { WorkspaceSource } from "./workspace-source";

export const MAX_DIFF_BYTES = 200_000;
export const DIFF_CONTEXT = 3;

/** Shape of the run-start baseline snapshot (relative path → original text). */
export type Baseline = Map<string, string>;

/**
 * Capture the current workspace contents as a baseline. Reads through the
 * run's `WorkspaceSource` (the user's persistent Box workspace).
 */
export async function captureWorkspaceSnapshot(
  source: WorkspaceSource,
): Promise<Baseline> {
  const files = await source.listFiles();
  const baseline: Baseline = new Map();
  for (const file of files) {
    if (file.size > MAX_DIFF_BYTES) continue;
    try {
      const read = await source.readFile(file.path);
      if (read.binary) continue;
      baseline.set(file.path, read.content);
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
  source: WorkspaceSource,
  baseline: Baseline,
): Promise<DiffResponse> {
  const current = await source.listFiles();

  const seen = new Set<string>();
  const files: DiffFile[] = [];

  for (const file of current) {
    seen.add(file.path);
    const original = baseline.get(file.path);
    let read;
    try {
      read = await source.readFile(file.path);
    } catch {
      continue;
    }
    const binary = read.binary || file.size > MAX_DIFF_BYTES;
    const text = binary ? "" : read.content;

    if (original === undefined) {
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

    if (text === original) continue;

    const hunks = toHunk(original, text) ?? [];
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