import { randomUUID } from "node:crypto";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
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
  private box: Box | null = null;

  constructor(options: BoxSandboxOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.runtime = options.runtime ?? "node";
    this.size = options.size ?? "small";
    this.initCommand = options.initCommand ?? "";
    this.baseUrl = options.baseUrl;
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
      try {
        return await Box.getByName(this.name, {
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
        });
      } catch (error) {
        if (isNotFound(error)) {
          return await Box.create({
            name: this.name,
            runtime: this.runtime,
            size: this.size,
            initCommand: this.initCommand,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
          });
        }
        throw error;
      }
    })();
    pendingStarts.set(this.name, promise);
    try {
      this.box = await promise;
    } finally {
      pendingStarts.delete(this.name);
    }
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