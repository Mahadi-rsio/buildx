import { randomUUID } from "node:crypto";
import { BoxSandbox } from "./box-sandbox";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
  SessionHandle,
  SessionOptions,
} from "./index";

export interface LazyBoxSandboxOptions {
  id?: string;
  /** Called once, on first operation that needs a box instance. */
  resolve: () => Promise<BoxSandbox>;
  /** Optional lifecycle hook for teardown (e.g. pause instead of delete). */
  onDestroy?: (box: BoxSandbox) => Promise<void>;
}

/**
 * Lazily attached box sandbox used by the box provider wiring:
 * - `start()` is a no-op (no box creation on run start)
 * - the first operation resolves and starts a `BoxSandbox`
 * - later calls reuse the same instance
 */
export class LazyBoxSandbox implements Sandbox {
  readonly id: string;
  private readonly resolveBox: () => Promise<BoxSandbox>;
  private readonly onDestroy?: (box: BoxSandbox) => Promise<void>;
  private resolving?: Promise<BoxSandbox>;

  constructor(options: LazyBoxSandboxOptions) {
    this.id = options.id ?? randomUUID();
    this.resolveBox = options.resolve;
    this.onDestroy = options.onDestroy;
  }

  private box(): Promise<BoxSandbox> {
    if (!this.resolving) {
      const attempt = this.resolveBox().then(async (box) => {
        await box.start();
        return box;
      });
      // A transient provider failure must not poison the sandbox forever:
      // clear the cached promise so the next operation retries. Concurrent
      // callers still share this attempt.
      this.resolving = attempt.catch((error: unknown) => {
        this.resolving = undefined;
        throw error;
      });
    }
    return this.resolving;
  }

  async start(): Promise<void> {
    // Intentionally lazy: no box creation on run start.
  }

  async suspend(): Promise<void> {
    if (!this.resolving) return;
    await (await this.resolving).suspend();
  }

  async destroy(): Promise<void> {
    if (!this.resolving) return;
    const box = await this.resolving;
    if (this.onDestroy) {
      await this.onDestroy(box);
      return;
    }
    await box.destroy();
  }

  async *exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk> {
    yield* (await this.box()).exec(cmd, opts);
  }

  async openSession(options: SessionOptions): Promise<SessionHandle> {
    return (await this.box()).openSession(options);
  }

  async readFile(path: string, range?: ReadRange): Promise<string> {
    return (await this.box()).readFile(path, range);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await (await this.box()).writeFile(path, content);
  }

  async startBackground(cmd: string): Promise<ProcId> {
    return (await this.box()).startBackground(cmd);
  }

  async checkpoint(label: string): Promise<CheckpointId> {
    return (await this.box()).checkpoint(label);
  }

  async restore(id: CheckpointId): Promise<void> {
    await (await this.box()).restore(id);
  }

  async previewUrl(port: number): Promise<string> {
    return (await this.box()).previewUrl(port);
  }
}