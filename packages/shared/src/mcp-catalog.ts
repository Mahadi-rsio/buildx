/**
 * MCP Marketplace catalog types + pure search/filter helpers.
 *
 * The catalog is curated in `apps/web/lib/mcp/catalog.ts`; this module only
 * holds the data contract and the testable query logic so both the API and the
 * UI render from the same shape.
 */

/** How a catalog entry authenticates to its remote endpoint. */
export type McpAuthMode = "none" | "api-key" | "oauth" | "local";

export const MCP_CATALOG_CATEGORIES = [
  "search",
  "knowledge",
  "code",
  "data",
  "dev-tools",
  "productivity",
  "observability",
  "finance",
] as const;
export type McpCatalogCategory = (typeof MCP_CATALOG_CATEGORIES)[number];

export const MCP_CATALOG_CATEGORY_LABELS: Record<McpCatalogCategory, string> = {
  search: "Search",
  knowledge: "Knowledge",
  code: "Code",
  data: "Data",
  "dev-tools": "Dev tools",
  productivity: "Productivity",
  observability: "Observability",
  finance: "Finance",
};

/** OAuth config for entries whose `authModes` include `"oauth"`. */
export interface McpOAuthConfig {
  /** Stable provider key used to derive env names, e.g. `github`. */
  provider: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface McpCatalogEntry {
  /** Stable slug, e.g. `context7`; also stored on `mcp_servers.catalog_id`. */
  id: string;
  name: string;
  summary: string;
  description: string;
  category: McpCatalogCategory;
  tags: string[];
  /** Small inline SVG/emoji glyph rendered by the marketplace card. */
  icon: string;
  /** Vendor docs / home page. */
  officialUrl: string;
  /** Official MCP Registry entry (qualified name), when published. */
  registryName?: string;
  /** Streamable HTTP endpoint. Absent for local-only entries. */
  endpoint?: string;
  authModes: McpAuthMode[];
  /** Header sent for `api-key` mode, e.g. `Authorization`. */
  apiKeyHeader?: string;
  /** Literal prefix before the key value, e.g. `Bearer `. */
  apiKeyPrefix?: string;
  oauth?: McpOAuthConfig;
  /** Featured in the marketplace hero row. */
  featured?: boolean;
  /** 0–100 popularity score used to order the grid. */
  popularity: number;
  /** Vendor-published (official) server. */
  verified: boolean;
  /** Example tool names surfaced on the card. */
  tools: string[];
  /** True when the server can only run as a local stdio process. */
  requiresLocal?: boolean;
  /** Optional caveat rendered under the card (e.g. hosted signup note). */
  note?: string;
}

export interface McpCatalogQuery {
  query?: string;
  category?: McpCatalogCategory | "all";
  /** Only entries that can be connected from this deployment. */
  connectableOnly?: boolean;
}

/** Lowercased haystack for substring search across name/summary/tags/tools. */
function searchHaystack(entry: McpCatalogEntry): string {
  return [
    entry.name,
    entry.summary,
    entry.description,
    ...entry.tags,
    ...entry.tools,
    entry.category,
  ]
    .join(" ")
    .toLowerCase();
}

/** True when an entry can be connected from BuildX (not local-only). */
export function isConnectable(entry: McpCatalogEntry): boolean {
  return !entry.requiresLocal && Boolean(entry.endpoint);
}

/**
 * Filter + rank the catalog. `query` is a case-insensitive substring match over
 * name/summary/description/tags/tools/category; `category` narrows; results are
 * ordered by `popularity` descending (featured first when `featuredFirst`).
 */
export function searchCatalog(
  entries: readonly McpCatalogEntry[],
  query: McpCatalogQuery = {},
): McpCatalogEntry[] {
  const needle = (query.query ?? "").trim().toLowerCase();
  const category = query.category ?? "all";

  const filtered = entries.filter((entry) => {
    if (query.connectableOnly && !isConnectable(entry)) return false;
    if (category !== "all" && entry.category !== category) return false;
    if (needle.length > 0 && !searchHaystack(entry).includes(needle)) return false;
    return true;
  });

  return [...filtered].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return b.popularity - a.popularity;
  });
}

/** Resolve one entry by id, or `undefined`. */
export function findCatalogEntry(
  entries: readonly McpCatalogEntry[],
  id: string,
): McpCatalogEntry | undefined {
  return entries.find((entry) => entry.id === id);
}