import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import {
  getInstalledSkillDetail,
  setInstalledSkillEnabled,
  uninstallSkillById,
} from "@/lib/skills/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/skills/:id` — full skill detail, including its stored artifact. */
export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;
  try {
    const detail = await getInstalledSkillDetail(user.id, id);
    if (!detail) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    console.error("[GET /api/skills/:id] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

/** `PATCH /api/skills/:id` — enable or disable an installed skill. */
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
  const enabled =
    typeof body === "object" && body !== null
      ? (body as { enabled?: unknown }).enabled
      : undefined;
  if (typeof enabled !== "boolean") {
    return Response.json(
      { error: "invalid_request", message: "enabled must be a boolean" },
      { status: 400 },
    );
  }

  try {
    const skill = await setInstalledSkillEnabled(user.id, id, enabled);
    if (!skill) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ skill });
  } catch (error) {
    console.error("[PATCH /api/skills/:id] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

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
