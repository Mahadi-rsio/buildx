import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
} from "./index";
import { resolveWorkspacePath } from "./path";

export interface LocalSandboxOptions {
  /** Directory the sandbox is rooted at; created if missing. */
  rootDir: string;
}

/**
 * A `Sandbox` backed by the local filesystem and shell. Intended for
 * development, tests, and single-machine use — no isolation is provided, so
 * paths are still confined to `rootDir` and every path-traversal attempt is
 * rejected.
 */
export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly rootDir: string;
  private readonly procs = new Map<ProcId, ChildProcess>();

  constructor(options: LocalSandboxOptions) {
    this.id = randomUUID();
    this.rootDir = resolve(options.rootDir);
  }

  private resolvePath(path: string): string {
    return resolveWorkspacePath(this.rootDir, path);
  }

  async start(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async suspend(): Promise<void> {
    // Nothing to suspend locally.
  }

  async destroy(): Promise<void> {
    for (const proc of this.procs.values()) {
      proc.kill("SIGKILL");
    }
    this.procs.clear();
  }

  async *exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
    const cwd = opts.cwd ? this.resolvePath(opts.cwd) : this.rootDir;
    // detached makes the shell a process-group leader so a timeout can kill the
    // whole tree (e.g. a `sh -c sleep` child); otherwise the orphaned child
    // keeps stdio open and `close` never fires promptly.
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
    });
    const killTree = (): void => {
      if (child.pid === undefined) {
        child.kill("SIGKILL");
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const queue: ExecChunk[] = [];
    let closed = false;
    let notify: (() => void) | undefined;
    const push = (chunk: ExecChunk): void => {
      queue.push(chunk);
      notify?.();
    };

    child.stdout?.on("data", (data: Buffer) =>
      push({ stream: "stdout", data: data.toString() }),
    );
    child.stderr?.on("data", (data: Buffer) =>
      push({ stream: "stderr", data: data.toString() }),
    );
    child.on("error", (error: Error) => {
      push({ stream: "stderr", data: `${error.message}\n` });
      closed = true;
      notify?.();
    });
    child.on("close", () => {
      closed = true;
      notify?.();
    });

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(killTree, opts.timeoutMs)
        : undefined;

    try {
      while (!closed || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((res) => {
            notify = res;
          });
          notify = undefined;
        }
        while (queue.length > 0) {
          yield queue.shift() as ExecChunk;
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async readFile(path: string, range: ReadRange = {}): Promise<string> {
    const content = await readFile(this.resolvePath(path), "utf8");
    if (range.offset === undefined && range.limit === undefined) {
      return content;
    }
    const lines = content.split("\n");
    const start = range.offset ?? 0;
    const end = range.limit === undefined ? undefined : start + range.limit;
    return lines.slice(start, end).join("\n");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.resolvePath(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async startBackground(cmd: string): Promise<ProcId> {
    const id = randomUUID();
    const child = spawn(cmd, {
      shell: true,
      cwd: this.rootDir,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("close", () => this.procs.delete(id));
    this.procs.set(id, child);
    return id;
  }

  async checkpoint(_label: string): Promise<CheckpointId> {
    // No-op locally: real adapters snapshot the volume and commit to git.
    return randomUUID();
  }

  async restore(_id: CheckpointId): Promise<void> {
    throw new Error("LocalSandbox.restore is not supported");
  }

  async previewUrl(port: number): Promise<string> {
    return `http://localhost:${port}`;
  }
}
