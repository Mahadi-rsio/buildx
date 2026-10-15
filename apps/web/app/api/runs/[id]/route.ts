import { getRun, toRunDetail } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `GET /api/runs/:id` — run row plus its append-only event log. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return Response.json({ error: "not_found", id }, { status: 404 });
  }
  return Response.json(toRunDetail(run));
}
