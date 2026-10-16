import type { RunTaskUsage } from "@buildx/agent";
import type { RunEvent, RunStatus } from "@buildx/shared";

/** Usage/step accounting surfaced on run responses (from `runTask`). */
export interface RunStats {
  steps: number;
  usage?: RunTaskUsage;
}

export interface RunSummary {
  id: string;
  task: string;
  status: RunStatus;
  model: string;
  maxSteps: number;
  /** Id of the sandbox workspace backing this run (equal to the run id here). */
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  stats?: RunStats;
  eventCount: number;
}

export interface RunDetail extends RunSummary {
  events: RunEvent[];
}

/** Entry returned by `GET /api/workspaces/:id/files`. */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface FilesResponse {
  path: string;
  type: "dir";
  entries: FileEntry[];
}

export interface FileContentResponse {
  path: string;
  type: "file";
  content: string;
  size: number;
  /** True when the file is not UTF-8 text; `content` is empty in that case. */
  binary?: boolean;
}

export type FilesResponseItem = FilesResponse | FileContentResponse;

/** One line inside a unified-diff hunk (from `diff.structuredPatch`). */
export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** A=added, M=modified, D=deleted. */
  status: "M" | "A" | "D";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when the file is binary or was skipped (too large) — no hunks. */
  binary?: boolean;
  size?: number;
  mtime?: number;
}

export interface DiffResponse {
  files: DiffFile[];
  /** Number of files compared but left unchanged (shown in the summary). */
  unchanged: number;
  skipped: number;
}
