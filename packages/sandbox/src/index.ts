/**
 * The backend-agnostic sandbox contract (arcetecture.md §2.4). Every adapter
 * (Upstash Box today; Sprites / Vercel Sandbox / Firecracker later) implements
 * this interface so the agent harness never depends on a specific backend.
 */

export { resolveWorkspacePath } from "./path";
export {
  buildCommand,
  capOutput,
  GitError,
  parseBranchList,
  parseChangedFiles,
  parseCommitList,
  pullRequestDraftPath,
  safeRepoName,
  sanitizeRemoteUrl,
  shellQuote,
  titleFromBranch,
  validateBranchName,
  validateRepoFile,
  validateRepoPath,
  validateRepositoryUrl,
  WorkspaceGit,
  type GitBranches,
  type GitChangedFile,
  type GitCloneResult,
  type GitCommitSummary,
  type GitErrorCode,
  type GitRepositoryInfo,
  type GitRepositorySummary,
  type GitStatusSummary,
  type PreparePullRequestInput,
  type PullRequestDraft,
  type PullRequestStatus,
  type StageCommitResult,
  type UpdatePullRequestInput,
} from "./git";

export type StreamName = "stdout" | "stderr";

export interface ExecOptions {
  /** Working directory relative to the workspace root. Defaults to the root. */
  cwd?: string;
  /** Extra environment variables merged over the process environment. */
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Abort the command (kills the process tree) when this signal fires. The
   * iterator then throws an `AbortError` so callers can distinguish worker
   * cancellation from a command that simply failed.
   */
  signal?: AbortSignal;
}

export interface ExecChunk {
  stream: StreamName;
  data: string;
}

/** Line-based read window: `offset` is a 0-based line, `limit` a line count. */
export interface ReadRange {
  offset?: number;
  limit?: number;
}

/** Signals accepted by live sessions (Box supports these process-tree signals). */
export type SessionSignal =
  | "TERM"
  | "KILL"
  | "INT"
  | "HUP"
  | "TSTP"
  | "QUIT"
  | "USR1"
  | "USR2";

export interface SessionOptions {
  /** Shell command, run via the backend's login shell. Ignored when `argv` is set. */
  cmd?: string;
  /** Exact program and arguments, without a shell. Takes precedence over `cmd`. */
  argv?: string[];
  /** Working directory relative to the workspace root. Defaults to the root. */
  cwd?: string;
  /** Extra environment variables merged over the process environment. */
  env?: Record<string, string>;
  /**
   * Allocate a PTY. Backends that support it merge stderr into stdout and
   * enable interactive programs. Defaults to true for terminal sessions.
   */
  tty?: boolean;
  rows?: number;
  cols?: number;
  /** Output callback. May fire before `openSession()` resolves. */
  onOutput?: (chunk: ExecChunk) => void;
}

/**
 * A live, interactive process. Unlike `exec()`, it accepts stdin, can be
 * resized/signalled, and must be closed when the client disconnects. Network
 * loss kills the process; live sessions cannot be reattached.
 */
export interface SessionHandle {
  /** In-box process id. */
  readonly pid: number;
  /** Backend-side execution id. */
  readonly execId: string;
  write(data: string | Uint8Array): void;
  /** Send EOF to stdin. */
  endStdin(): void;
  /** Resize the PTY. No-op for non-TTY sessions. */
  resize(rows: number, cols: number): void;
  /** Send one signal to the process tree. Defaults to TERM. */
  kill(signal?: SessionSignal): void;
  /** SIGTERM, then SIGKILL after `graceMs`. */
  terminate(graceMs?: number): void;
  /** Resolve with the process exit code. */
  wait(): Promise<number>;
  /** Close the connection, terminating the process if still running. */
  close(): void;
}

export type ProcId = string;
export type CheckpointId = string;

export { BoxSandbox, type BoxSandboxOptions } from "./box-sandbox";
export {
  LazyBoxSandbox,
  type LazyBoxSandboxOptions,
} from "./lazy-box";

export interface Sandbox {
  readonly id: string;

  start(): Promise<void>;
  /** Idle → cheap. Adapters without a suspend primitive may stop instead. */
  suspend(): Promise<void>;
  destroy(): Promise<void>;

  /** Run a command, streaming combined stdout/stderr until it exits. */
  exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk>;

  /**
   * Open a live process with stdin/signals/optional PTY. Optional because not
   * every backend supports interactive sessions; callers must handle absence.
   */
  openSession?(options: SessionOptions): Promise<SessionHandle>;

  /** Read a file, optionally restricted to a line range. */
  readFile(path: string, range?: ReadRange): Promise<string>;
  /** Create or overwrite a file. */
  writeFile(path: string, content: string): Promise<void>;

  /** Start a long-lived process (e.g. a dev server) and return its handle. */
  startBackground(cmd: string): Promise<ProcId>;

  /** Create a rollback point: volume snapshot + git commit. */
  checkpoint(label: string): Promise<CheckpointId>;
  /** Restore to a checkpoint by spinning a fresh volume from a snapshot. */
  restore(id: CheckpointId): Promise<void>;

  /** Public URL for a port exposed by the workspace. */
  previewUrl(port: number): Promise<string>;
}
