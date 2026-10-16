import { randomUUID } from "node:crypto";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
} from "./index";

/** A path in the sandbox filesystem. */
export interface FsEntry {
  name: string;
  type: "file" | "dir";
}

/** A read of a file from the daemon's /fs endpoint. */
export interface ReadResult {
  content: string;
  binary: boolean;
  size: number;
  mtime: number;
  type?: "file" | "dir";
}

/** Options for the HTTP-served sandbox daemon (arcetecture.md §2.3). */
export interface DaemonSandboxOptions {
  /** Base URL of the sandbox daemon, e.g. `http://<machine-ip>:8080`. */
  baseUrl: string;
  /** Bearer token the daemon was started with (SANDBOX_TOKEN). */
  token: string;
  /** Timeout for a single HTTP request, default 30s. */
  requestTimeoutMs?: number;
}

const NDJSON = new TextDecoder();

/**
 * A `Sandbox` that executes commands and touches files by calling the
 * sandbox-daemon over HTTP. The daemon runs inside the Fly machine image and
 * scopes all paths to its workspace root (/workspace). Every method that goes
 * to the wire streams/chunks so long tool output does not buffer in memory.
 */
export class DaemonSandbox implements Sandbox {
  readonly id: string;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DaemonSandboxOptions) {
    this.id = randomUUID();
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers || {}) },
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.json()).error as string;
        } catch {
          // Non-JSON error body; keep `detail` empty.
        }
        throw new Error(
          `sandbox daemon ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async start(): Promise<void> {
    const response = await this.request("/healthz");
    const body = (await response.json()) as { ok?: boolean };
    if (!body.ok) throw new Error("sandbox daemon health check failed");
  }

  async suspend(): Promise<void> {
    // The daemon has no suspend primitive; the Fly machine is stopped by the
    // orchestrator through the Machines API instead.
  }

  async destroy(): Promise<void> {
    // Nothing to tear down from the daemon's perspective.
  }

  async *exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
    const controller = new AbortController();
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => controller.abort(), opts.timeoutMs + 500)
      : undefined;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/exec`, {
        method: "POST",
        headers: {
          ...this.headers(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cmd,
          cwd: opts.cwd,
          env: opts.env,
          timeoutMs: opts.timeoutMs,
        }),
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = (await response.json()).error as string;
      } catch {
        // Ignore parse errors on the error body.
      }
      throw new Error(
        `sandbox daemon /exec ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    const reader = response.body.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += NDJSON.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as
          | { stream: "stdout" | "stderr"; data: string }
          | { exit: number };
        if ("exit" in message) return;
        yield { stream: message.stream, data: message.data };
      }
    }
  }

  async readFile(path: string, range: ReadRange = {}): Promise<string> {
    const query = new URLSearchParams({ path });
    if (range.offset !== undefined) query.set("offset", String(range.offset));
    if (range.limit !== undefined) query.set("limit", String(range.limit));
    const response = await this.request(`/fs?${query.toString()}`);
    const body = (await response.json()) as ReadResult;
    if (body.binary) throw new Error(`cannot read binary file: ${path}`);
    return body.content;
  }

  /** Read a file (or inspect a dir) plus metadata, without rejecting binary. */
  async readInfo(path: string): Promise<ReadResult & { type?: "file" | "dir" }> {
    const response = await this.request(`/fs?path=${encodeURIComponent(path)}`);
    return (await response.json()) as ReadResult & { type?: "file" | "dir" };
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.request("/fs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
  }

  /** List the entries of a directory (relative) in the workspace. */
  async listDir(path = ""): Promise<FsEntry[]> {
    const response = await this.request(`/fs?path=${encodeURIComponent(path)}`);
    const body = (await response.json()) as { type: "dir"; entries: FsEntry[] };
    return body.entries;
  }

  async startBackground(cmd: string): Promise<ProcId> {
    // The daemon API is stateless around exec; background processes are not
    // supported yet, so run it detached via exec is not truthful. Callers can
    // use `nohup … &` through exec until /bg lands.
    void cmd;
    throw new Error("background processes require the /bg daemon endpoint");
  }

  async checkpoint(_label: string): Promise<CheckpointId> {
    // The Fly adapter snapshots the volume + git via the Machines API; the
    // daemon-level client defers to the orchestrator. No-op client-side.
    return randomUUID();
  }

  async restore(_id: CheckpointId): Promise<void> {
    throw new Error("DaemonSandbox.restore is not supported");
  }

  async previewUrl(port: number): Promise<string> {
    const url = this.baseUrl.replace(/^http(s)?:\/\//, "");
    return `http://${url}:${port}`;
  }
}