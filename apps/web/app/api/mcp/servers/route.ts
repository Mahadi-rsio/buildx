import { assertSafeMcpUrl, McpSecurityError } from "@buildx/agent";
import { eq, getDb, mcpServers } from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { encryptJson } from "@/lib/mcp/crypto";
import { toMcpServerView } from "@/lib/mcp/store";
import {
  cleanHeaders,
  firstIssue,
  githubMcpDisabled,
  isBlockedGitHubMcp,
  isMissingTableError,
  mcpServerCreateSchema,
  privateHostsAllowed,
  schemaNotMigrated,
} from "@/lib/mcp/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/mcp/servers` — the caller's configured MCP servers. */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  try {
    const rows = await getDb()
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.userId, user.id))
      .orderBy(mcpServers.createdAt);
    return Response.json({ servers: rows.map(toMcpServerView) });
  } catch (error: unknown) {
    if (isMissingTableError(error)) return schemaNotMigrated();
    console.error("[GET /api/mcp/servers] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

/** `POST /api/mcp/servers` — add a Streamable HTTP MCP server. */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = mcpServerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: firstIssue(parsed.error) },
      { status: 400 },
    );
  }
  const input = parsed.data;
  if (isBlockedGitHubMcp({ catalogId: input.catalogId, url: input.url })) {
    return githubMcpDisabled();
  }
  if (input.allowPrivate && !privateHostsAllowed()) {
    return Response.json(
      {
        error: "private_hosts_disabled",
        message: "Private and local MCP hosts are disabled on this deployment.",
      },
      { status: 400 },
    );
  }

  try {
    await assertSafeMcpUrl(input.url, {
      allowPrivate: input.allowPrivate ?? false,
    });
  } catch (error) {
    if (error instanceof McpSecurityError) {
      return Response.json(
        { error: "unsafe_url", message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }

  const headers = cleanHeaders(input.headers);
  try {
    const [row] = await getDb()
      .insert(mcpServers)
      .values({
        userId: user.id,
        name: input.name,
        url: input.url,
        headersEncrypted: headers ? encryptJson(headers) : null,
        enabled: input.enabled ?? true,
        allowPrivate: input.allowPrivate ?? false,
        catalogId: input.catalogId ?? null,
      })
      .returning();
    return Response.json({ server: toMcpServerView(row) }, { status: 201 });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return Response.json(
        { error: "name_taken", message: "A server with that name already exists." },
        { status: 409 },
      );
    }
    console.error("[POST /api/mcp/servers] error:", error);
    if (isMissingTableError(error)) return schemaNotMigrated();
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
