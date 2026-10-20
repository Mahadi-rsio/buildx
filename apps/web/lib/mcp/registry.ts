/**
 * Official MCP Registry discovery client (registry.modelcontextprotocol.io).
 *
 * The registry hosts a paginated Streamable-HTTP-only catalog (API v0.1, in
 * freeze). We fetch it server-side with a short TTL and merge results into the
 * curated catalog in the API route. The registry is best-effort: failures
 * degrade to the curated catalog instead of erroring the page.
 */

export const MCP_REGISTRY_BASE_URL =
  process.env.MCP_REGISTRY_BASE_URL ?? "https://registry.modelcontextprotocol.io";

const CACHE_TTL_MS = 5 * 60_000;
const PAGE_LIMIT = 100;

export interface RegistryServer {
  /** Qualified name, e.g. `com.github/mcp`. */
  name: string;
  title: string | null;
  description: string | null;
  version: string;
  /** First Streamable HTTP remote URL, when present. */
  endpoint: string | null;
  /** `true` when the entry has an `official` registry annotation. */
  official: boolean;
}

interface RegistryListResponse {
  servers?: Array<{
    server: {
      name: string;
      title?: string;
      description?: string;
      version?: string;
      remotes?: Array<{ type?: string; url?: string }>;
    };
    _meta?: Record<string, unknown>;
  }>;
  metadata?: { nextCursor?: string; count?: number };
}

const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";

function parseServers(payload: RegistryListResponse): RegistryServer[] {
  return (payload.servers ?? []).map((entry) => ({
    name: entry.server.name,
    title: entry.server.title ?? null,
    description: entry.server.description ?? null,
    version: entry.server.version ?? "unknown",
    endpoint:
      entry.server.remotes?.find((remote) => remote.type === "streamable-http")
        ?.url ?? null,
    official:
      (entry._meta?.[OFFICIAL_META_KEY] as { status?: string } | undefined)
        ?.status === "active",
  }));
}

interface CacheEntry {
  fetchedAt: number;
  servers: RegistryServer[];
}

const globalForRegistry = globalThis as unknown as {
  __BUILDX_MCP_REGISTRY__?: {
    cache: Map<string, CacheEntry>;
    inflight: Map<string, Promise<RegistryServer[]>>;
  };
};

function registryState() {
  if (!globalForRegistry.__BUILDX_MCP_REGISTRY__) {
    globalForRegistry.__BUILDX_MCP_REGISTRY__ = {
      cache: new Map(),
      inflight: new Map(),
    };
  }
  return globalForRegistry.__BUILDX_MCP_REGISTRY__;
}

export interface FetchRegistryOptions {
  search?: string;
  /** Bypass the in-memory cache (used by the connect form after changes). */
  fresh?: boolean;
}

/**
 * Fetch registry servers, cached in-process for `CACHE_TTL_MS`. Concurrent
 * callers share one in-flight request. Never throws — returns `[]` on failure.
 */
export async function fetchRegistryServers(
  options: FetchRegistryOptions = {},
): Promise<RegistryServer[]> {
  const { state } = { state: registryState() };
  const key = (options.search ?? "").trim().toLowerCase();

  if (!options.fresh) {
    const cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.servers;
    }
    const inflight = state.inflight.get(key);
    if (inflight) return inflight;
  }

  const params = new URLSearchParams({
    version: "latest",
    limit: String(PAGE_LIMIT),
  });
  if (key.length > 0) params.set("search", key);

  const request = (async (): Promise<RegistryServer[]> => {
    try {
      const response = await fetch(
        `${MCP_REGISTRY_BASE_URL}/v0.1/servers?${params.toString()}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return [];
      const payload = (await response.json()) as RegistryListResponse;
      const servers = parseServers(payload);
      state.cache.set(key, { fetchedAt: Date.now(), servers });
      return servers;
    } catch (error) {
      console.warn(
        `[mcp-registry] fetch failed for "${key}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    } finally {
      state.inflight.delete(key);
    }
  })();

  state.inflight.set(key, request);
  return request;
}