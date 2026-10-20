import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

/** Hard cap on the text a single MCP tool call may return to the model. */
export const MAX_MCP_OUTPUT_CHARS = 30_000;
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
const MAX_TOOL_NAME_LENGTH = 64;

export interface McpServerConfig {
  id: string;
  /** Human-readable label; also used to prefix tool names. */
  name: string;
  /** Streamable HTTP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string;
  /** Headers sent with every request. Credentials never leave the server. */
  headers?: Record<string, string>;
  /** Per-request timeout for connect/list/call. */
  timeoutMs?: number;
  /**
   * Permit connecting to loopback/private addresses. Only enable for trusted
   * local development servers; production configs must leave this unset.
   */
  allowPrivate?: boolean;
}

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

export interface McpConnection {
  config: McpServerConfig;
  tools: McpToolInfo[];
  readonly client: Client;
  callTool(
    name: string,
    input: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

function allowPrivateByDefault(): boolean {
  return process.env.MCP_ALLOW_PRIVATE_HOSTS === "true";
}

function ipv4ToInt(address: string): number {
  const parts = address.split(".").map((part) => Number(part));
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

function inCidr(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function isBlockedIpv4(address: string): boolean {
  return BLOCKED_IPV4.some(([base, prefix]) => inCidr(address, base, prefix));
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  // IPv4-mapped addresses (::ffff:127.0.0.1) inherit the IPv4 policy.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // fe80::/10
  if (normalized.startsWith("ff")) return true; // ff00::/8
  return false;
}

function isBlockedHostName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host === "metadata.google.internal" ||
    host === "metadata"
  );
}

/**
 * Reject endpoints that could reach the host's loopback, private network, or a
 * cloud metadata service. Hostnames are resolved so a public DNS name that
 * points at a private address is rejected too (basic DNS-rebinding defense).
 */
export async function assertSafeMcpUrl(
  raw: string,
  options: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpSecurityError("MCP server URL is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpSecurityError("MCP server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new McpSecurityError("MCP server URL must not embed credentials");
  }

  const allowPrivate = options.allowPrivate ?? allowPrivateByDefault();
  if (allowPrivate) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostName(hostname)) {
    throw new McpSecurityError(
      "MCP server URL points at a local or internal host",
    );
  }

  const literal = isIP(hostname);
  if (literal === 4) {
    if (isBlockedIpv4(hostname)) {
      throw new McpSecurityError(
        "MCP server URL points at a private or reserved address",
      );
    }
    return url;
  }
  if (literal === 6) {
    if (isBlockedIpv6(hostname)) {
      throw new McpSecurityError(
        "MCP server URL points at a private or reserved address",
      );
    }
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new McpSecurityError(`Could not resolve MCP server host "${hostname}"`);
  }
  if (addresses.length === 0) {
    throw new McpSecurityError(`Could not resolve MCP server host "${hostname}"`);
  }
  for (const entry of addresses) {
    const blocked =
      entry.family === 4
        ? isBlockedIpv4(entry.address)
        : isBlockedIpv6(entry.address);
    if (blocked) {
      throw new McpSecurityError(
        `MCP server host "${hostname}" resolves to a private or reserved address`,
      );
    }
  }
  return url;
}

/**
 * A fetch wrapper that re-validates every request target. Combined with the
 * transport's `redirectPolicy: "same-origin"`, this blocks a redirect into the
 * private network. It does not guarantee request-time DNS pinning, so it is a
 * defense in depth layered over a URL that was already validated.
 */
function createSafeFetch(allowPrivate: boolean): typeof fetch {
  return async (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (/^https?:/i.test(href)) {
      await assertSafeMcpUrl(href, { allowPrivate });
    }
    return fetch(input, init);
  };
}

function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  if (schema.type === "object") return schema;
  return { ...schema, type: "object" };
}

function contentToText(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): { text: string; isError: boolean } {
  const pieces: string[] = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (!part || typeof part !== "object") continue;
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        pieces.push(item.text);
      } else if (item.type === "image") {
        pieces.push(`[image ${String(item.mimeType ?? "unknown")}]`);
      } else if (item.type === "audio") {
        pieces.push(`[audio ${String(item.mimeType ?? "unknown")}]`);
      } else if (item.type === "resource") {
        const resource = item.resource as Record<string, unknown> | undefined;
        if (typeof resource?.text === "string") pieces.push(resource.text);
        else pieces.push(`[resource ${String(resource?.uri ?? "unknown")}]`);
      } else if (item.type === "resource_link") {
        pieces.push(`[resource ${String(item.uri ?? "unknown")}]`);
      } else {
        pieces.push(`[${String(item.type ?? "unknown")} content]`);
      }
    }
  }
  if (result.structuredContent !== undefined) {
    try {
      pieces.push(JSON.stringify(result.structuredContent));
    } catch {
      // ignore non-serializable structured content
    }
  }
  let text = pieces.join("\n").trim();
  if (text.length === 0) text = "(no output)";
  if (text.length > MAX_MCP_OUTPUT_CHARS) {
    text =
      text.slice(0, MAX_MCP_OUTPUT_CHARS) +
      `\n\n… ${text.length - MAX_MCP_OUTPUT_CHARS} characters omitted …`;
  }
  return { text, isError: result.isError === true };
}

/** Connect to one Streamable HTTP MCP server and discover its tools. */
export async function connectMcpServer(
  config: McpServerConfig,
  options: { signal?: AbortSignal } = {},
): Promise<McpConnection> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const allowPrivate = config.allowPrivate ?? allowPrivateByDefault();
  const url = await assertSafeMcpUrl(config.url, { allowPrivate });

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { ...(config.headers ?? {}) },
    },
    fetch: createSafeFetch(allowPrivate),
    redirectPolicy: "same-origin",
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 1,
    },
  });
  const client = new Client(
    { name: "buildx", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { timeout: timeoutMs, signal: options.signal });
    const listed = await client.listTools(undefined, {
      timeout: timeoutMs,
      signal: options.signal,
    });
    const tools: McpToolInfo[] = (listed.tools ?? []).map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: normalizeInputSchema(
        entry.inputSchema as Record<string, unknown> | undefined,
      ),
      annotations: entry.annotations,
    }));

    return {
      config,
      tools,
      client,
      async callTool(name, input, callOptions = {}) {
        const result = await client.callTool(
          {
            name,
            arguments:
              input && typeof input === "object"
                ? (input as Record<string, unknown>)
                : {},
          },
          undefined,
          {
            timeout: callOptions.timeoutMs ?? timeoutMs,
            signal: callOptions.signal,
          },
        );
        return contentToText(result as Parameters<typeof contentToText>[0]);
      },
      async close() {
        try {
          await transport.terminateSession();
        } catch {
          // Servers may not support explicit session termination (405).
        }
        await client.close();
      },
    };
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

/** List a server's tools without keeping the connection open. */
export async function listMcpServerTools(
  config: McpServerConfig,
  options: { signal?: AbortSignal } = {},
): Promise<McpToolInfo[]> {
  const connection = await connectMcpServer(config, options);
  try {
    return connection.tools;
  } finally {
    await connection.close();
  }
}

export interface McpToolCallEvent {
  serverId: string;
  serverName: string;
  toolName: string;
  isError: boolean;
}

export interface BuildMcpToolsOptions {
  /**
   * Gate for tools the server marks destructive. When omitted, destructive
   * tools are rejected rather than silently executed.
   */
  approve?: (call: {
    serverId: string;
    serverName: string;
    toolName: string;
    input: unknown;
  }) => boolean | Promise<boolean>;
  onCall?: (event: McpToolCallEvent) => void | Promise<void>;
}

function sanitizeToolName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "mcp";
}

/**
 * Convert discovered MCP tools into AI SDK tools. Names are namespaced per
 * server (`server__tool`) so two servers may expose the same tool name, and the
 * map `serverByTool` lets the run loop tag events with the server.
 */
export function buildMcpTools(
  connections: McpConnection[],
  options: BuildMcpToolsOptions = {},
): { tools: ToolSet; serverByTool: Record<string, McpConnection> } {
  const tools: Record<string, Tool> = {};
  const serverByTool: Record<string, McpConnection> = {};

  for (const connection of connections) {
    const serverId = connection.config.id;
    const serverName = connection.config.name;
    const prefix = sanitizeToolName(serverName);
    for (const info of connection.tools) {
      let name = `${prefix}__${sanitizeToolName(info.name)}`.slice(
        0,
        MAX_TOOL_NAME_LENGTH,
      );
      let suffix = 2;
      while (tools[name]) {
        const tail = `_${suffix++}`;
        name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - tail.length)}${tail}`;
      }

      const destructive = info.annotations?.destructiveHint === true;
      const annotationNote = destructive
        ? "\n\nThis tool is marked destructive by its MCP server; confirm with the user before calling it."
        : "";

      tools[name] = tool({
        description: `${info.description ?? "MCP tool"} (MCP server: ${serverName})${annotationNote}`,
        inputSchema: jsonSchema(
          normalizeInputSchema(info.inputSchema) as Parameters<
            typeof jsonSchema
          >[0],
        ),
        execute: async (input, execOptions) => {
          if (execOptions?.abortSignal?.aborted) {
            throw new Error("Tool execution aborted: run cancelled");
          }
          if (destructive) {
            const approved = options.approve
              ? await options.approve({ serverId, serverName, toolName: info.name, input })
              : false;
            if (!approved) {
              throw new Error(
                `Tool "${info.name}" on MCP server "${serverName}" is marked destructive and requires approval.`,
              );
            }
          }
          const { text, isError } = await connection.callTool(info.name, input, {
            signal: execOptions?.abortSignal,
          });
          await options.onCall?.({
            serverId,
            serverName,
            toolName: info.name,
            isError,
          });
          if (isError) throw new Error(text);
          return text;
        },
      });
      serverByTool[name] = connection;
    }
  }

  return { tools, serverByTool };
}
