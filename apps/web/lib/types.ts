import type { RunTaskUsage } from "@buildx/agent";
import type {
  ContextUsagePayload,
  ContextWindowTokens,
  ConversationTurn,
  RunEvent,
  RunStatus,
} from "@buildx/shared";

/** Usage/step accounting surfaced on run responses (from `runTask`). */
export interface RunStats {
  steps: number;
  usage?: RunTaskUsage;
  /** Live context-window accounting from the last usage event, when emitted. */
  context?: ContextUsagePayload;
}

export interface WorkspaceUsage {
  cpuHoursUsed: number;
  cpuHoursLimit: number;
  dailyRequestsUsed: number;
  dailyRequestsLimit: number;
  nextDhakaResetAt: number;
}

export interface WorkspaceRuntime {
  status:
    | "idle"
    | "workspace.restoring"
    | "workspace.ready"
    | "workspace.archiving"
    | "workspace.archived";
  step?: string;
  message?: string;
  idleDeadlineAt?: number;
  usage?: WorkspaceUsage;
  workspaceId?: string;
}

export interface RunSummary {
  id: string;
  /** Conversation grouping this run (follow-up turns share it). */
  conversationId?: string;
  task: string;
  status: RunStatus;
  model: string;
  maxSteps: number;
  /** Context window selected for this run (compaction + utilization). */
  contextWindowTokens: ContextWindowTokens;
  /** Id of the sandbox workspace backing this run (equal to the run id here). */
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stats?: RunStats;
  workspace: WorkspaceRuntime;
  eventCount: number;
}

export interface RunDetail extends RunSummary {
  events: RunEvent[];
  /** Earlier conversation turns replayed before this run's task. */
  history?: ConversationTurn[];
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
