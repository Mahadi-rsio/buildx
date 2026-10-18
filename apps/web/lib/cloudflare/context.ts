/**
 * Access Cloudflare Worker bindings (Queues, R2, KV, Hyperdrive).
 * Works seamlessly inside Cloudflare Workers via `@opennextjs/cloudflare`
 * and falls back safely in local Node.js / unit tests.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface QueueBinding {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

export interface KVBinding {
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<unknown>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2ObjectBody {
  body: ReadableStream;
  size?: number;
  httpEtag?: string;
  version?: string;
  httpMetadata?: R2HttpMetadata;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface R2Binding {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
  head(key: string): Promise<unknown | null>;
}

export interface HyperdriveBinding {
  connectionString: string;
}

export interface CloudflareEnv {
  BUILDX_QUEUE?: QueueBinding;
  BUILDX_QUEUE_DLQ?: QueueBinding;
  BUILDX_KV?: KVBinding;
  BUILDX_R2?: R2Binding;
  HYPERDRIVE?: HyperdriveBinding;
  [key: string]: unknown;
}

/** In-memory test queue for local dev and tests when Cloudflare Queues are not configured. */
export class MemoryQueue implements QueueBinding {
  readonly messages: unknown[] = [];
  async send(message: unknown): Promise<void> {
    this.messages.push(message);
  }
}

/** In-memory test KV for local dev and tests. */
export class MemoryKV implements KVBinding {
  private store = new Map<string, { value: unknown; expiresAt?: number }>();

  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream",
  ): Promise<unknown>;
  async get(
    key: string,
    type: "text" | "json" | "arrayBuffer" | "stream" = "text",
  ): Promise<unknown> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    if (type === "json") {
      return typeof item.value === "string" ? JSON.parse(item.value) : item.value;
    }
    return typeof item.value === "string" ? item.value : JSON.stringify(item.value);
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

let simulatedQueue: MemoryQueue | undefined;
let simulatedKV: MemoryKV | undefined;

export function getSimulatedQueue(): MemoryQueue {
  if (!simulatedQueue) simulatedQueue = new MemoryQueue();
  return simulatedQueue;
}

export function getSimulatedKV(): MemoryKV {
  if (!simulatedKV) simulatedKV = new MemoryKV();
  return simulatedKV;
}

let currentWorkerEnv: CloudflareEnv | undefined;

export function setWorkerEnv(env: unknown): void {
  if (env && typeof env === "object") {
    currentWorkerEnv = env as CloudflareEnv;
    for (const [key, val] of Object.entries(env)) {
      if (typeof val === "string" && val.length > 0) {
        process.env[key] = val;
      }
    }
  }
}

/**
 * Safely retrieve Cloudflare environment bindings.
 * Returns real bindings in Cloudflare Workers, or simulated fallbacks in local/test.
 */
export function getCloudflareBindings(): CloudflareEnv {
  try {
    const ctx = getCloudflareContext();
    if (ctx && ctx.env) return ctx.env as unknown as CloudflareEnv;
  } catch {
    // Expected when running outside Cloudflare Worker environment (e.g. tests, node scripts)
  }

  if (currentWorkerEnv) {
    return currentWorkerEnv;
  }

  return {
    BUILDX_QUEUE: getSimulatedQueue(),
    BUILDX_KV: getSimulatedKV(),
  };
}
