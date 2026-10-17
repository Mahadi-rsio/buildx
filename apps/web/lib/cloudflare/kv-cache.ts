import { getCloudflareBindings } from "./context";

/**
 * Cloudflare KV cache helper.
 * Strictly used for disposable, transient cache data with appropriate TTLs.
 * Authoritative transactional data MUST reside in Neon PostgreSQL.
 */

export const DEFAULT_CACHE_TTL_SECONDS = 300; // 5 minutes

export async function getCache<T>(key: string): Promise<T | null> {
  const bindings = getCloudflareBindings();
  if (!bindings.BUILDX_KV) return null;

  try {
    const raw = await bindings.BUILDX_KV.get(key, "text");
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`[kv-cache] failed to get cache for key ${key}`, error);
    return null;
  }
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS,
): Promise<void> {
  const bindings = getCloudflareBindings();
  if (!bindings.BUILDX_KV) return;

  try {
    const serialized = JSON.stringify(value);
    await bindings.BUILDX_KV.put(key, serialized, {
      expirationTtl: Math.max(60, ttlSeconds), // KV minimum TTL is 60 seconds
    });
  } catch (error) {
    console.warn(`[kv-cache] failed to set cache for key ${key}`, error);
  }
}

export async function deleteCache(key: string): Promise<void> {
  const bindings = getCloudflareBindings();
  if (!bindings.BUILDX_KV) return;

  try {
    await bindings.BUILDX_KV.delete(key);
  } catch (error) {
    console.warn(`[kv-cache] failed to delete cache for key ${key}`, error);
  }
}
