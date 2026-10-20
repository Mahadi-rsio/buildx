import { assertSafeMcpUrl, listMcpServerTools, McpSecurityError } from "@buildx/agent";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { cleanHeaders, firstIssue, mcpServerCreateSchema, privateHostsAllowed } from "@/lib/mcp/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TEST_TIMEOUT_MS = 15_000;

/**
 * `POST /api/mcp/servers/test` — verify connectivity for a server that has not
 * been saved yet (the add/edit form's "Test connection" button). Runs the same
 * SSRF check as `POST /api/mcp/servers` and lists the discovered tools, but
 * writes nothing to the database.
 */
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

  const config = {
    id: `test-${user.id}`,
    name: input.name,
    url: input.url,
    headers: cleanHeaders(input.headers),
    allowPrivate: input.allowPrivate ?? false,
    timeoutMs: TEST_TIMEOUT_MS,
  };

  try {
    const tools = await listMcpServerTools(config);
    return Response.json({ ok: true, tools });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof McpSecurityError ? 400 : 502;
    return Response.json(
      {
        ok: false,
        error: "connection_failed",
        message,
      },
      { status },
    );
  }
}
