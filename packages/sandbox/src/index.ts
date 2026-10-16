/**
 * The backend-agnostic sandbox contract (arcetecture.md §2.4). Every adapter
 * (Fly Machines today; Sprites / Vercel Sandbox / Firecracker later) implements
 * this interface so the agent harness never depends on a specific backend.
 */

export { resolveWorkspacePath } from "./path";

export type StreamName = "stdout" | "stderr";

export interface ExecOptions {
  /** Working directory relative to the workspace root. Defaults to the root. */
  cwd?: string;
  /** Extra environment variables merged over the process environment. */
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
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

export type ProcId = string;
export type CheckpointId = string;

export { LocalSandbox, type LocalSandboxOptions } from "./local";
export {
  DaemonSandbox,
  type DaemonSandboxOptions,
  type FsEntry,
  type ReadResult,
} from "./daemon";

export interface Sandbox {
  readonly id: string;

  start(): Promise<void>;
  /** Idle → cheap. Adapters without a suspend primitive may stop instead. */
  suspend(): Promise<void>;
  destroy(): Promise<void>;

  /** Run a command, streaming combined stdout/stderr until it exits. */
  exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk>;

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
