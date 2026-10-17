import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { refreshRun, toRunDetail } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `GET /api/runs/:id` — run row plus its append-only event log. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const owned = await findOwnedRun(id, user.id);
  if (!owned) return notFound(id);
  // Postgres is the source of truth for status/lease: reflect transitions that
  // happened in another instance instead of serving a stale cached snapshot.
  const run = (await refreshRun(id)) ?? owned;
  return Response.json(await toRunDetail(run));
}
