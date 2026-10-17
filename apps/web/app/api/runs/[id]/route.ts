import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { toRunDetail } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `GET /api/runs/:id` — run row plus its append-only event log. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);
  return Response.json(toRunDetail(run));
}
