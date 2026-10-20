import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { uninstallSkillById } from "@/lib/skills/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** `DELETE /api/skills/:id` — uninstall one of the caller's skills. */
export async function DELETE(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;
  try {
    const removed = await uninstallSkillById(user.id, id);
    if (!removed) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("[DELETE /api/skills/:id] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
