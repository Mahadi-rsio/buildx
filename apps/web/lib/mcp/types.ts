/** Client-safe representation of a stored MCP server. Mirrors
 * `toMcpServerView` in `@/lib/mcp/store` and never includes ciphertext or
 * plaintext credentials. */
export interface McpServerView {
  id: string;
  name: string;
  transport: "streamable_http";
  url: string;
  enabled: boolean;
  allowPrivate: boolean;
  hasHeaders: boolean;
  lastStatus: "unknown" | "connected" | "error";
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Tool metadata discovered from an MCP server (connection list response). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}