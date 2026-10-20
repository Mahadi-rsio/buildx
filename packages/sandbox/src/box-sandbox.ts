import { randomUUID } from "node:crypto";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
  SessionHandle,
  SessionOptions,
  SessionSignal,
} from "./index";
import { Box, BoxError } from "@upstash/box";
import type { BoxSize, Runtime } from "@upstash/box";
import { resolveWorkspacePath } from "./path";
import { abortError, ChunkBuffer, exitMarker } from "./buffer";

const WORKSPACE = "/workspace/home";

/** POSIX single-quote a value so it's safe to embed in shell commands. */
function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface BoxSandboxOptions {
  name: string;
  apiKey: string;
  runtime?: Runtime;
  size?: BoxSize;
  initCommand?: string;
  baseUrl?: string;
  /**
   * Keep the box running when idle instead of allowing Upstash to auto-pause.
   * Defaults to false: ordinary workspaces should pause when nobody is using
   * them so idle time is not billed as active CPU.
   */
  keepAlive?: boolean;
  /**
   * Snapshot to restore from when no box with `name` exists. This is only used
   * after an explicit, lease-protected retention step; a missing snapshot must
   * fail closed rather than silently create an empty workspace.
   */
  restoreSnapshotId?: string;
  /** Pre-attached Box instance (for testing or restore). */
  box?: Box;
}

/** True when the Box SDK reported "not found" (404) for an existing box. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof BoxError &&
    typeof error.statusCode === "number" &&
    error.statusCode === 404
  );
}

/**
 * In-process guard so two concurrent `start()` calls for the same box name
 * (e.g. the resolver building a LazyBoxSandbox from parallel route handlers)
 * cannot double-create a box on the Upstash side.
 */
const pendingStarts = new Map<string, Promise<Box>>();

/**
 * A `Sandbox` backend for Upstash Box.
 *
 * Maps the BuildX `Sandbox` interface onto the `@upstash/box` SDK v0.7.9.
 * Box lifecycle (idle auto-pause) replaces the `FREE_IDLE_MINUTES` logic.
 * Snapshots replace volume snapshots + MinIO backup.
 * Agent loop stays outside the box (keys never enter the microVM).
 */
export class BoxSandbox implements Sandbox {
  readonly id: string;
  private name: string;
  private apiKey: string;
  private runtime: Runtime;
  private size: BoxSize;
  private initCommand: string;
  private baseUrl: string | undefined;
  private keepAlive: boolean;
  private restoreSnapshotId: string | undefined;
  private box: Box | null = null;

  constructor(options: BoxSandboxOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.runtime = options.runtime ?? "node";
    this.size = options.size ?? "small";
    this.initCommand = options.initCommand ?? "";
    this.baseUrl = options.baseUrl;
    this.keepAlive = options.keepAlive ?? false;
    this.restoreSnapshotId = options.restoreSnapshotId;
    this.id = this.name;
    this.box = options.box ?? null;
  }

  async start(): Promise<void> {
    if (this.box) return; // already attached (tests / restore)

    // Share one provision/reconnect promise per box name so concurrent start()
    // calls never race Box.create (each would otherwise provision a duplicate
    // box — the getByName-then-create pattern is not atomic across callers).
    const inFlight = pendingStarts.get(this.name);
    if (inFlight) {
      this.box = await inFlight;
      return;
    }

    const promise = (async (): Promise<Box> => {
      let box: Box;
      try {
        box = await Box.getByName(this.name, {
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        box = await this.createOrReconnect();
      }
      await this.resumeIfPaused(box);
      return box;
    })();
    pendingStarts.set(this.name, promise);
    try {
      this.box = await promise;
    } finally {
      pendingStarts.delete(this.name);
    }
  }

  /**
   * Create a box, restoring from a snapshot when retention metadata exists.
   * `getByName` → `create` is not atomic across server instances: if another
   * instance won the race, `create` can fail. Reconnect to the winner instead
   * of surfacing a spurious failure (and never overwrite their workspace).
   */
  private async createOrReconnect(): Promise<Box> {
    if (this.restoreSnapshotId) {
      try {
        return await Box.fromSnapshot(this.restoreSnapshotId, {
          name: this.name,
          runtime: this.runtime,
          size: this.size,
          initCommand: this.initCommand,
          keepAlive: this.keepAlive,
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
        });
      } catch (error) {
        // A concurrent restore may have already recreated the named box.
        try {
          return await Box.getByName(this.name, {
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
          });
        } catch {
          throw error;
        }
      }
    }

    try {
      return await Box.create({
        name: this.name,
        runtime: this.runtime,
        size: this.size,
        initCommand: this.initCommand,
        keepAlive: this.keepAlive,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
      });
    } catch (error) {
      try {
        return await Box.getByName(this.name, {
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
        });
      } catch {
        throw error;
      }
    }
  }

  /** Resume a paused box before the first operation. Running boxes are left as-is. */
  private async resumeIfPaused(box: Box): Promise<void> {
    try {
      const { status } = await box.getStatus();
      if (/paused|stopped|idle/i.test(status)) await box.resume();
    } catch {
      // Status probing is best-effort: a box that is already running (or an
      // older API that omits status) should not block the run. The following
      // operation will surface any real backend error.
    }
  }

  /**
   * Attach to an existing box without creating one. Returns `false` when the
   * box does not exist yet so read-only consumers (file browser, diff) never
   * provision a box on their own.
   */
  async connect(): Promise<boolean> {
    if (this.box) return true;

    const inFlight = pendingStarts.get(this.name);
    if (inFlight) {
      this.box = await inFlight;
      return true;
    }

    try {
      this.box = await Box.getByName(this.name, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Explicitly make the box ready for new work. Unlike the lazy `start()` used
   * by read-only consumers, this resumes a paused attached box (or starts one
   * when no box is attached yet). Callers that must not provision a workspace
   * should attach with `connect()` first and only call this after that succeeds.
   */
  async ensureRunning(): Promise<void> {
    if (!this.box) {
      await this.start();
      return;
    }
    await this.resumeIfPaused(this.box);
  }

  async suspend(): Promise<void> {
    if (!this.box) return;
    try {
      await this.box.pause();
    } catch {
      // Box may already be paused or keepAlive may prevent pause; best-effort.
    }
  }

  async destroy(): Promise<void> {
    if (!this.box) return;
    await this.box.delete();
    this.box = null;
  }

  /** Current Upstash status (running/paused/...), or null before start. */
  async status(): Promise<string | null> {
    if (!this.box) return null;
    return (await this.box.getStatus()).status;
  }

  /**
   * Snapshot the workspace. Snapshots are independent of the box lifecycle, so
   * retention callers must persist the returned id before deleting the box.
   */
  async snapshot(name: string): Promise<string> {
    if (!this.box) throw new Error("sandbox not started");
    return (await this.box.snapshot({ name })).id;
  }

  /** Explicitly pause the box (idempotent best-effort). */
  async pause(): Promise<void> {
    await this.suspend();
  }

  async *exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk> {
    if (!this.box) throw new Error("sandbox not started");

    const env = opts?.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    // Validate the cwd against the workspace root (rejects `..` traversal); the
    // relative path given by tools is resolved inside the box's workspace.
    const cwd = opts?.cwd ? this.resolvePath(opts.cwd) : WORKSPACE;

    // Check abort before starting so we never touch the network when already
    // cancelled.
    const error = abortError("command aborted");
    if (opts?.signal?.aborted) throw error;

    // Bounded head+tail collector: a runaway command can never exhaust memory.
    const buffer = new ChunkBuffer();
    let done = false;
    let exitCode = 0;
    let failure: Error | null = null;
    let notify: (() => void) | undefined;
    const wake = (): void => notify?.();

    // Build the full shell command string.
    // exec.stream() takes a single `command` string and runs it with `sh -c`
    // on the box. We prepend `cd <cwd>` if needed, and inline env vars via the
    // POSIX `env NAME=value ...` prefix. This avoids the WebSocket-based
    // exec.session() API (which imports the `ws` npm package) — fetch-based SSE
    // works correctly in Cloudflare Workers and all other runtimes.
    const parts: string[] = [];
    if (env && env.length > 0) {
      parts.push(`env ${env.map((kv) => shellQuoteSingle(kv)).join(" ")}`);
    }
    if (cwd !== WORKSPACE) {
      parts.push(`cd ${shellQuoteSingle(cwd)}`);
    }
    parts.push(cmd);
    const fullCmd = parts.join(" && ");

    // exec.stream() returns a StreamRun whose async iterator yields
    // { type:"output"; data:string } | { type:"exit"; exitCode:number } chunks.
    // All output is combined (no stdout/stderr separation at this API level).
    const streamRun = await this.box.exec.stream(fullCmd);

    // Drain the SSE stream in the background, filling the buffer.
    const drainPromise = (async () => {
      try {
        for await (const chunk of streamRun) {
          // Stop draining as soon as the caller aborts or we timeout.
          if (failure) break;
          if (chunk.type === "output") {
            buffer.push({ stream: "stdout", data: chunk.data });
            wake();
          } else if (chunk.type === "exit") {
            exitCode = chunk.exitCode;
            break;
          }
        }
      } catch (err) {
        if (!failure) {
          failure = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        done = true;
        wake();
      }
    })();

    const timeoutMs = opts?.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            if (!failure) failure = new Error(`command timed out after ${timeoutMs}ms`);
            void (streamRun as unknown as { cancel?: () => Promise<void> }).cancel?.();
            wake();
          }, timeoutMs)
        : undefined;

    const abort = (): void => {
      if (!failure) failure = error;
      void (streamRun as unknown as { cancel?: () => Promise<void> }).cancel?.();
      wake();
    };
    if (opts?.signal?.aborted) {
      abort();
    } else {
      opts?.signal?.addEventListener("abort", abort, { once: true });
    }

    try {
      while (true) {
        if (!buffer.empty) {
          yield* buffer.drain();
          continue;
        }
        if (done || failure) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
          if (done || failure || !buffer.empty) resolve();
        }).finally(() => {
          notify = undefined;
        });
      }
      if (!failure) await drainPromise;
      if (!buffer.empty) yield* buffer.drain();
      if (failure) throw failure;
      const marker = exitMarker(exitCode);
      if (marker) yield marker;
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", abort);
      void (streamRun as unknown as { cancel?: () => Promise<void> }).cancel?.();
    }
  }

  /**
   * Open a live shell session over the SDK's WebSocket API. This is the only
   * path that supports stdin, PTY resizing, and process-tree signals; `exec()`
   * remains the one-way streaming path used by the agent's bash tool.
   */
  async openSession(options: SessionOptions): Promise<SessionHandle> {
    if (!this.box) throw new Error("sandbox not started");
    if (!options.cmd && !options.argv) {
      throw new Error("session requires cmd or argv");
    }

    const cwd = options.cwd ? this.resolvePath(options.cwd) : WORKSPACE;
    const env = options.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : undefined;
    const tty = options.tty ?? true;
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const emit = (stream: "stdout" | "stderr", data: Uint8Array): void => {
      const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
      const text = decoder.decode(data, { stream: true });
      if (text.length > 0) options.onOutput?.({ stream, data: text });
    };
    const flush = (): void => {
      const out = stdoutDecoder.decode();
      const err = stderrDecoder.decode();
      if (out.length > 0) options.onOutput?.({ stream: "stdout", data: out });
      if (err.length > 0) options.onOutput?.({ stream: "stderr", data: err });
    };

    const session = await this.box.exec.session({
      ...(options.argv ? { argv: options.argv } : { cmd: options.cmd }),
      cwd,
      tty,
      ...(env && env.length > 0 ? { env } : {}),
      ...(tty && options.rows ? { rows: options.rows } : {}),
      ...(tty && options.cols ? { cols: options.cols } : {}),
      onStdout: (data) => emit("stdout", data),
      onStderr: (data) => emit("stderr", data),
    });

    return {
      pid: session.pid,
      execId: session.execId,
      write: (data) => session.write(data),
      endStdin: () => session.endStdin(),
      resize: (rows, cols) => session.resize(rows, cols),
      kill: (signal?: SessionSignal) => session.kill(signal),
      terminate: (graceMs?: number) => session.terminate(graceMs),
      wait: async () => {
        try {
          return await session.wait();
        } finally {
          flush();
        }
      },
      close: () => {
        flush();
        session.close();
      },
    };
  }

  async readFile(path: string, range?: ReadRange): Promise<string> {
    if (!this.box) throw new Error("sandbox not started");
    const fullPath = this.resolvePath(path);
    const stat = await this.box.files.stat(fullPath, { follow: true });
    if (stat.type !== "file") {
      throw new Error(`cannot read: ${path} is not a file`);
    }

    const MAX_BYTES = 8 * 1024 * 1024;
    const size = Math.min(stat.size, MAX_BYTES);
    let content: string;

    if (size > 0) {
      const b64 = await this.box.files.read(fullPath, {
        offset: 0,
        length: size,
        encoding: "base64",
      });
      const buf = Buffer.from(b64, "base64");
      // Detect binary: presence of null bytes
      if (buf.length > 0 && buf.includes(0)) {
        throw new Error(`cannot read binary file: ${path}`);
      }
      content = buf.toString("utf8");
    } else {
      content = "";
    }

    // If a line range was requested, split and slice
    if (range?.offset !== undefined || range?.limit !== undefined) {
      const start = range.offset ?? 0;
      const end = range.limit !== undefined ? start + range.limit : undefined;
      const lines = content.split("\n");
      if (end !== undefined) {
        return lines.slice(start, end).join("\n");
      }
      return lines.slice(start).join("\n");
    }

    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.box) throw new Error("sandbox not started");
    await this.box.files.write({
      path: this.resolvePath(path),
      content,
    });
  }

  async startBackground(cmd: string): Promise<ProcId> {
    if (!this.box) throw new Error("sandbox not started");
    // nohup + & patterns; the command backgrounds immediately, exit code is 0
    const logName = `..buildx/bg-${randomUUID()}.log`;
    const shell = `nohup ${cmd} > ${this.resolvePath(logName)} 2>&1 &`;
    await this.box.exec.command(shell);
    return logName;
  }

  async checkpoint(label: string): Promise<CheckpointId> {
    if (!this.box) throw new Error("sandbox not started");
    const snap = await this.box.snapshot({ name: label });
    return snap.id;
  }

  async restore(id: CheckpointId): Promise<void> {
    if (!this.box) throw new Error("sandbox not started");
    // Box.fromSnapshot returns a new box; swap the internal reference.
    const nb = await Box.fromSnapshot(id, {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      initCommand: this.initCommand,
    });
    this.box = nb;
  }

  async previewUrl(port: number): Promise<string> {
    if (!this.box) throw new Error("sandbox not started");
    const { url } = await this.box.getPublicURL(port);
    return url;
  }

  /** Resolve a user-relative path to the box's filesystem path. */
  private resolvePath(rel: string): string {
    return resolveWorkspacePath(WORKSPACE, rel);
  }

  /** List directory entries for the WorkspaceSource. */
  async listDir(rel: string): Promise<{ name: string; path: string; type: "file" | "dir" }[]> {
    if (!this.box) throw new Error("sandbox not started");
    const clean = rel === "." ? "" : rel.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (clean && (clean.startsWith("/") || clean.split("/").includes(".."))) {
      throw new Error("path escapes sandbox root");
    }
    const entries = await this.box.files.list(this.resolvePath(clean || ""));
    const parent = clean;
    return entries
      .filter((e) => !["node_modules", ".git", ".next", "dist", "coverage", "build", ".turbo"].includes(e.name))
      .map((e) => ({
        name: e.name,
        path: parent ? `${parent}/${e.name}` : e.name,
        type: e.is_dir ? "dir" : "file",
      }));
  }

  /** Read file metadata + content for the WorkspaceSource. */
  async readInfo(path: string): Promise<{ content: string; binary: boolean; size: number; mtime?: number }> {
    if (!this.box) throw new Error("sandbox not started");
    const fullPath = this.resolvePath(path);
    try {
      const stat = await this.box.files.stat(fullPath, { follow: true });
      if (stat.type !== "file") {
        return { content: "", binary: true, size: 0 };
      }
      // Read up to 1MB to detect binary + get content
      const b64 = await this.box.files.read(fullPath, {
        offset: 0,
        length: 1024 * 1024,
        encoding: "base64",
      });
      const buf = Buffer.from(b64, "base64");
      const binary = buf.includes(0);
      const text = binary ? "" : buf.toString("utf8");
      return { content: text, binary, size: stat.size, mtime: new Date(stat.mod_time).getTime() };
    } catch {
      return { content: "", binary: true, size: 0 };
    }
  }

  /** List all files recursively (for diff baseline capture). */
  async listFiles(): Promise<{ path: string; size: number; mtime?: number }[]> {
    if (!this.box) throw new Error("sandbox not started");
    const out: { path: string; size: number; mtime?: number }[] = [];
    const ignored = new Set(["node_modules", ".git", ".next", "dist", "coverage", "build", ".turbo"]);
    const walk = async (dir: string) => {
      const entries = await this.listDir(dir);
      for (const entry of entries) {
        if (ignored.has(entry.name)) continue;
        if (entry.type === "dir") {
          await walk(entry.path);
          continue;
        }
        const info = await this.readInfo(entry.path);
        out.push({ path: entry.path, size: info.size, mtime: info.mtime });
      }
    };
    await walk("");
    return out;
  }

  /** Discover whether a path is a file or directory; null when missing. */
  async stat(rel: string): Promise<{ type: "file" | "dir" } | null> {
    if (!this.box) throw new Error("sandbox not started");
    const fullPath = this.resolvePath(rel);
    try {
      const s = await this.box.files.stat(fullPath, { follow: true });
      if (s.type === "directory") return { type: "dir" };
      if (s.type === "file") return { type: "file" };
      return null;
    } catch {
      return null;
    }
  }

  /** Resolve a path, rejecting traversal. */
  resolve(rel: string): string {
    const clean = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (clean.startsWith("/") || clean.split("/").includes("..")) {
      throw new Error("path escapes sandbox root");
    }
    return clean;
  }
}