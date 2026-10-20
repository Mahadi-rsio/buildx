import { assertSafeMcpUrl, McpSecurityError } from "@buildx/agent";
import { and, eq, getDb, mcpServers } from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { encryptJson } from "@/lib/mcp/crypto";
import { findMcpServer, toMcpServerView } from "@/lib/mcp/store";
import {
  cleanHeaders,
  firstIssue,
  isMissingTableError,
  mcpServerUpdateSchema,
  privateHostsAllowed,
  schemaNotMigrated,
} from "@/lib/mcp/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/mcp/servers/:id` */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;

  try {
    const row = await findMcpServer(user.id, id);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ server: toMcpServerView(row) });
  } catch (error: unknown) {
    if (isMissingTableError(error)) return schemaNotMigrated();
    console.error("[GET /api/mcp/servers/:id] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

/** `PATCH /api/mcp/servers/:id` — update, enable, or disable a server. */
export async function PATCH(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = mcpServerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: firstIssue(parsed.error) },
      { status: 400 },
    );
  }
  const input = parsed.data;
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
    const existing = await findMcpServer(user.id, id);
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });

    const nextUrl = input.url ?? existing.url;
    const nextAllowPrivate = input.allowPrivate ?? existing.allowPrivate;
    if (input.url !== undefined || input.allowPrivate !== undefined) {
      await assertSafeMcpUrl(nextUrl, { allowPrivate: nextAllowPrivate });
    }

    const changes: Partial<typeof mcpServers.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.name !== undefined) changes.name = input.name;
    if (input.url !== undefined) changes.url = input.url;
    if (input.enabled !== undefined) changes.enabled = input.enabled;
    if (input.allowPrivate !== undefined) {
      changes.allowPrivate = input.allowPrivate;
    }
    if (input.headers !== undefined) {
      const headers = cleanHeaders(input.headers);
      changes.headersEncrypted = headers ? encryptJson(headers) : null;
    }
    if (
      input.url !== undefined ||
      input.headers !== undefined ||
      input.allowPrivate !== undefined
    ) {
      changes.lastStatus = "unknown";
      changes.lastError = null;
      changes.lastCheckedAt = null;
    }

    const [row] = await getDb()
      .update(mcpServers)
      .set(changes)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)))
      .returning();
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ server: toMcpServerView(row) });
  } catch (error: unknown) {
    if (error instanceof McpSecurityError) {
      return Response.json(
        { error: "unsafe_url", message: error.message },
        { status: 400 },
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
    ) {
      return Response.json(
        { error: "name_taken", message: "A server with that name already exists." },
        { status: 409 },
      );
    }
    if (isMissingTableError(error)) return schemaNotMigrated();
    console.error("[PATCH /api/mcp/servers/:id] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

/** `DELETE /api/mcp/servers/:id` */
export async function DELETE(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;

  try {
    const rows = await getDb()
      .delete(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)))
      .returning({ id: mcpServers.id });
    if (rows.length === 0) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    if (isMissingTableError(error)) return schemaNotMigrated();
    console.error("[DELETE /api/mcp/servers/:id] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
