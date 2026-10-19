/**
 * Cloudflare bindings are no longer used. This file provides empty stubs for
 * backward compatibility during the migration and will be removed.
 */

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

export interface R2ObjectBody {
  body: ReadableStream;
  size?: number;
  httpEtag?: string;
  version?: string;
  httpMetadata?: {
    contentType?: string;
    contentLanguage?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheControl?: string;
    cacheExpiry?: Date;
  };
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

export interface CloudflareEnv {
  BUILDX_QUEUE?: QueueBinding;
  BUILDX_KV?: KVBinding;
  BUILDX_R2?: R2Binding;
  [key: string]: unknown;
}

/**
 * Returns empty bindings. Cloudflare Worker bindings are no longer used.
 * R2 is accessed via the S3 SDK through @buildx/storage instead.
 */
export function getCloudflareBindings(): CloudflareEnv {
  return {};
}

export function setWorkerEnv(_env: unknown): void {
  // No-op: Cloudflare Worker env is no longer used
}
