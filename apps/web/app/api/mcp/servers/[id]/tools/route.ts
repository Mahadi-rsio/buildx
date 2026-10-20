import { listMcpServerTools, McpSecurityError } from "@buildx/agent";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findMcpServer, toMcpServerConfig } from "@/lib/mcp/store";
import { isMissingTableError, schemaNotMigrated } from "@/lib/mcp/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIST_TIMEOUT_MS = 15_000;

type Params = { params: Promise<{ id: string }> };

/** `GET /api/mcp/servers/:id/tools` — discover the server's tools (no writes). */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;

  try {
    const row = await findMcpServer(user.id, id);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });

    const config = { ...toMcpServerConfig(row), timeoutMs: LIST_TIMEOUT_MS };
    const tools = await listMcpServerTools(config);
    return Response.json({ tools });
  } catch (error: unknown) {
    if (isMissingTableError(error)) return schemaNotMigrated();
    const message = error instanceof Error ? error.message : String(error);
    console.error("[GET /api/mcp/servers/:id/tools] error:", error);
    return Response.json(
      { error: error instanceof McpSecurityError ? "unsafe_url" : "connection_failed", message },
      { status: error instanceof McpSecurityError ? 400 : 502 },
    );
  }
}
