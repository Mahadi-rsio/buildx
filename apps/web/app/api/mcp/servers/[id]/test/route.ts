import { listMcpServerTools, McpSecurityError } from "@buildx/agent";
import { eq, getDb, mcpServers } from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findMcpServer, toMcpServerConfig, toMcpServerView } from "@/lib/mcp/store";
import { isMissingTableError, schemaNotMigrated } from "@/lib/mcp/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TEST_TIMEOUT_MS = 15_000;

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/mcp/servers/:id/test` — connect, list tools, and persist the
 * result so the settings list can show reachability.
 */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;

  try {
    const row = await findMcpServer(user.id, id);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });

    try {
      const config = { ...toMcpServerConfig(row), timeoutMs: TEST_TIMEOUT_MS };
      const tools = await listMcpServerTools(config);
      const [updated] = await getDb()
        .update(mcpServers)
        .set({
          lastStatus: "connected",
          lastError: null,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, row.id))
        .returning();
      return Response.json({
        ok: true,
        server: toMcpServerView(updated),
        tools,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      const [updated] = await getDb()
        .update(mcpServers)
        .set({
          lastStatus: "error",
          lastError: message.slice(0, 1000),
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, row.id))
        .returning();
      const status = error instanceof McpSecurityError ? 400 : 502;
      return Response.json(
        {
          ok: false,
          error: "connection_failed",
          message,
          server: toMcpServerView(updated),
        },
        { status },
      );
    }
  } catch (error: unknown) {
    if (isMissingTableError(error)) return schemaNotMigrated();
    console.error("[POST /api/mcp/servers/:id/test] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
