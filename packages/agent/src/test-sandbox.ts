import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  resolveWorkspacePath,
  type CheckpointId,
  type ExecChunk,
  type ExecOptions,
  type ProcId,
  type ReadRange,
  type Sandbox,
} from "@buildx/sandbox";

function abortError(message = "The operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Test-only in-process sandbox. It is intentionally not exported from
 * `@buildx/sandbox`: production code may only execute in Upstash Box.
 */
export class TestSandbox implements Sandbox {
  readonly id = randomUUID();
  readonly rootDir: string;
  private readonly procs = new Map<ProcId, ChildProcess>();

  constructor(options: { rootDir: string }) {
    this.rootDir = resolvePath(options.rootDir);
  }

  private resolvePath(path: string): string {
    return resolveWorkspacePath(this.rootDir, path);
  }

  async start(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async suspend(): Promise<void> {}

  async destroy(): Promise<void> {
    for (const proc of this.procs.values()) proc.kill("SIGKILL");
    this.procs.clear();
  }

  async *exec(
    cmd: string,
    opts: ExecOptions = {},
  ): AsyncIterable<ExecChunk> {
    const cwd = opts.cwd ? this.resolvePath(opts.cwd) : this.rootDir;
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
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
    let exitCode: number | null = null;
    let failure: Error | null = null;
    let notify: (() => void) | undefined;
    const wake = (): void => notify?.();
    const push = (chunk: ExecChunk): void => {
      queue.push(chunk);
      wake();
    };

    child.stdout?.on("data", (data: Buffer) =>
      push({ stream: "stdout", data: data.toString() }),
    );
    child.stderr?.on("data", (data: Buffer) =>
      push({ stream: "stderr", data: data.toString() }),
    );
    child.on("error", (error: Error) => {
      failure = error;
      closed = true;
      wake();
    });
    child.on("close", (code: number | null) => {
      exitCode = code;
      closed = true;
      wake();
    });

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(killTree, opts.timeoutMs)
        : undefined;

    const abort = (): void => {
      if (!failure) failure = abortError("command aborted");
      killTree();
      wake();
    };
    if (opts.signal?.aborted) {
      abort();
    } else {
      opts.signal?.addEventListener("abort", abort, { once: true });
    }

    try {
      while (true) {
        if (queue.length > 0) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          continue;
        }
        if (closed || failure) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
          if (closed || failure || queue.length > 0) resolve();
        }).finally(() => {
          notify = undefined;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
      if (failure) throw failure;
      if ((exitCode ?? 0) !== 0) {
        yield {
          stream: "stderr",
          data: `\n[buildx: command exited with code ${exitCode ?? 0}]\n`,
        };
      }
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      killTree();
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
    return randomUUID();
  }

  async restore(_id: CheckpointId): Promise<void> {
    throw new Error("TestSandbox.restore is not supported");
  }

  async previewUrl(port: number): Promise<string> {
    return `http://localhost:${port}`;
  }
}
