/**
 * Cloudflare KV cache helper is no longer used.
 * The application uses PostgreSQL for all persistent state.
 * This file provides no-op stubs for backward compatibility during migration.
 */

export const DEFAULT_CACHE_TTL_SECONDS = 300;

export async function getCache<T>(_key: string): Promise<T | null> {
  // KV cache is removed; all authoritative data lives in Neon PostgreSQL.
  return null;
}

export async function setCache<T>(
  _key: string,
  _value: T,
  _ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS,
): Promise<void> {
  // No-op: KV cache is removed.
}

export async function deleteCache(_key: string): Promise<void> {
  // No-op: KV cache is removed.
}
