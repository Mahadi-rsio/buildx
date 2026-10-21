import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findGitHubConnection, toGitHubConnectionView } from "@/lib/github/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/github/status` — connection state for Settings. */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  try {
    const row = await findGitHubConnection(user.id);
    return Response.json(toGitHubConnectionView(row));
  } catch (error) {
    console.error("[GET /api/github/status] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
