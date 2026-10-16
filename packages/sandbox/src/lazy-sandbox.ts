import { randomUUID } from "node:crypto";
import { DaemonSandbox } from "./daemon";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
} from "./index";

export interface LazySandboxConnection {
  baseUrl: string;
  token: string;
}

export interface LazySandboxOptions {
  id?: string;
  /** Called once, on first remote operation that needs a daemon. */
  resolve: () => Promise<LazySandboxConnection>;
  /** Optional lifecycle hook used by the orchestrator for archive teardown. */
  onDestroy?: (connection: LazySandboxConnection) => Promise<void>;
}

/**
 * Lazy remote sandbox wrapper used by Phase 8 web wiring:
 * - `start()` is a no-op (no machine boot on run start)
 * - the first tool operation resolves to `DaemonSandbox`
 * - later calls reuse the same daemon connection
 */
export class LazySandbox implements Sandbox {
  readonly id: string;
  private readonly resolveConnection: () => Promise<LazySandboxConnection>;
  private readonly onDestroy?: (connection: LazySandboxConnection) => Promise<void>;
  private resolving?: Promise<DaemonSandbox>;
  private connection?: LazySandboxConnection;

  constructor(options: LazySandboxOptions) {
    this.id = options.id ?? randomUUID();
    this.resolveConnection = options.resolve;
    this.onDestroy = options.onDestroy;
  }

  private async daemon(): Promise<DaemonSandbox> {
    if (!this.resolving) {
      this.resolving = this.resolveConnection().then((connection) => {
        this.connection = connection;
        return new DaemonSandbox({
          baseUrl: connection.baseUrl,
          token: connection.token,
        });
      });
    }
    return this.resolving;
  }

  async start(): Promise<void> {
    // Intentionally lazy: no machine creation on run start.
  }

  async suspend(): Promise<void> {
    if (!this.resolving) return;
    const daemon = await this.resolving;
    await daemon.suspend();
  }

  async destroy(): Promise<void> {
    if (!this.resolving) return;
    const daemon = await this.resolving;
    if (this.onDestroy && this.connection) {
      await this.onDestroy(this.connection);
      return;
    }
    await daemon.destroy();
  }

  async *exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const daemon = await this.daemon();
    yield* daemon.exec(cmd, opts);
  }

  async readFile(path: string, range?: ReadRange): Promise<string> {
    return (await this.daemon()).readFile(path, range);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await (await this.daemon()).writeFile(path, content);
  }

  async startBackground(cmd: string): Promise<ProcId> {
    return (await this.daemon()).startBackground(cmd);
  }

  async checkpoint(label: string): Promise<CheckpointId> {
    return (await this.daemon()).checkpoint(label);
  }

  async restore(id: CheckpointId): Promise<void> {
    await (await this.daemon()).restore(id);
  }

  async previewUrl(port: number): Promise<string> {
    return (await this.daemon()).previewUrl(port);
  }
}
