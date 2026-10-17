import { randomUUID } from "node:crypto";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
} from "./index";
import { Box } from "@upstash/box";
import type { BoxSize, Runtime } from "@upstash/box";
import { resolveWorkspacePath } from "./path";

const WORKSPACE = "/workspace/home";

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
    if (this.box) return; // already initialized

    if (this.box === null) {
      // Try to get an existing box by name (idempotent re-connect)
      try {
        this.box = await Box.getByName(this.name);
      } catch {
        // Box not found; create a new one
        this.box = await Box.create({
          name: this.name,
          runtime: this.runtime,
          size: this.size,
          initCommand: this.initCommand,
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
        });
      }
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
    if (!this.box) {
      yield* this.dummyExec();
      return;
    }

    const env = opts?.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const cwd = opts?.cwd
      ? `${WORKSPACE}/${opts.cwd.replace(/^\.?\//, "")}`
      : WORKSPACE;

    const chunks: ExecChunk[] = [];
    let done = false;
    let timeoutHit = false;

    const onChunk = (stream: "stdout" | "stderr", data: string) => {
      chunks.push({ stream, data });
    };

    const session = await this.box.exec.session({
      cmd,
      cwd,
      env,
      onStdout: (data: Uint8Array) => onChunk("stdout", Buffer.from(data).toString("utf8")),
      onStderr: (data: Uint8Array) => onChunk("stderr", Buffer.from(data).toString("utf8")),
    });

    const exitPromise = session.wait().then(() => {
      done = true;
    });

    const timeoutMs = opts?.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timeoutHit = true;
            session.terminate(1000);
          }, timeoutMs)
        : undefined;

    try {
      while (true) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
          if (done) break;
          continue;
        }
        if (done) {
          // Process exited; drain any remaining chunks
          while (chunks.length > 0) {
            yield chunks.shift()!;
          }
          break;
        }
        if (timeoutHit) {
          throw new Error(`command timed out after ${opts?.timeoutMs}ms`);
        }
        // Wait briefly for next chunk or exit event
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
      await exitPromise;
      if (timeoutHit) {
        throw new Error(`command timed out after ${opts?.timeoutMs}ms`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      session.close();
    }
  }

  private async *dummyExec(): AsyncIterable<ExecChunk> {
    // Fallback when no box is available (e.g. test without API key).
    yield ({
      stream: "stdout",
      data: "sandbox not ready",
    });
    return;
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