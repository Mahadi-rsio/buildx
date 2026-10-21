import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { deleteGitHubConnection } from "@/lib/github/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/github/disconnect` — forget stored GitHub tokens. */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  try {
    await deleteGitHubConnection(user.id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[POST /api/github/disconnect] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
