import { and, eq, getDb, mcpServers } from "@buildx/db";
import type { McpServerConfig } from "@buildx/agent";
import { decryptJson } from "./crypto";
import { isBlockedGitHubMcp, privateHostsAllowed } from "./validation";
import type { McpServerView } from "./types";

export type McpServerRow = typeof mcpServers.$inferSelect;

export type { McpServerView } from "./types";

export function toMcpServerView(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    catalogId: row.catalogId,
    enabled: row.enabled,
    allowPrivate: row.allowPrivate && privateHostsAllowed(),
    hasHeaders: Boolean(row.headersEncrypted),
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMcpServers(userId: string): Promise<McpServerRow[]> {
  return getDb()
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.userId, userId))
    .orderBy(mcpServers.createdAt);
}

export async function findMcpServer(
  userId: string,
  id: string,
): Promise<McpServerRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)));
  return row;
}

/** Decrypt the stored headers, if any. Throws if the payload is corrupt. */
export function readMcpHeaders(row: McpServerRow): Record<string, string> {
  if (!row.headersEncrypted) return {};
  const decoded = decryptJson<Record<string, string>>(row.headersEncrypted);
  return decoded && typeof decoded === "object" ? decoded : {};
}

/** Decrypted runtime config for one stored row. */
export function toMcpServerConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    headers: readMcpHeaders(row),
    allowPrivate: row.allowPrivate && privateHostsAllowed(),
  };
}

/**
 * Runtime config for every enabled server owned by `userId`. A corrupt or
 * undecryptable row is skipped with a warning: one bad config must not prevent
 * unrelated runs or servers from working.
 */
export async function loadEnabledMcpServerConfigs(
  userId: string,
): Promise<McpServerConfig[]> {
  const rows = await getDb()
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.enabled, true)));
  const configs: McpServerConfig[] = [];
  for (const row of rows) {
    // GitHub MCP is retired. Old rows may still be enabled in the database, so
    // never let them contribute tools to a run.
    if (isBlockedGitHubMcp({ catalogId: row.catalogId, url: row.url })) {
      console.warn(`[mcp] skipping retired GitHub MCP server ${row.id}`);
      continue;
    }
    try {
      configs.push({
        id: row.id,
        name: row.name,
        url: row.url,
        headers: readMcpHeaders(row),
        allowPrivate: row.allowPrivate && privateHostsAllowed(),
      });
    } catch (error) {
      console.warn(`[mcp] skipping server ${row.id}: ${String(error)}`);
    }
  }
  return configs;
}
