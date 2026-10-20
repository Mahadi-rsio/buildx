import { z } from "zod";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { draftNotFound, gitErrorResponse, workspaceGit } from "@/lib/git";
import { resolveWorkspaceBox, tryGetWorkspaceBox } from "@/lib/sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const querySchema = z.object({
  path: z.string().trim().min(1).max(1024),
  base: z.string().trim().min(1).max(255),
  head: z.string().trim().min(1).max(255),
});

const updateSchema = querySchema.extend({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20_000),
});

function invalid(message: string): Response {
  return Response.json({ error: "invalid_request", message }, { status: 400 });
}

/**
 * `GET /api/workspaces/:id/git/pr?path=&base=&head=` — load the persisted local
 * draft. Read-only: never creates a box.
 */
export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    path: url.searchParams.get("path") ?? "",
    base: url.searchParams.get("base") ?? "",
    head: url.searchParams.get("head") ?? "",
  });
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? "invalid request");
  }

  const box = await tryGetWorkspaceBox(run.userId);
  if (!box) return draftNotFound();

  try {
    const git = workspaceGit(box);
    const draft = await git.loadDraft(parsed.data.path, parsed.data.head);
    if (!draft || draft.baseBranch !== parsed.data.base) return draftNotFound();
    return Response.json({ draft });
  } catch (error) {
    return gitErrorResponse(error);
  }
}

/**
 * `PUT /api/workspaces/:id/git/pr` — save the operator's title/description.
 * Push status is always recomputed from real git state; client-supplied
 * status/open/merged fields are ignored.
 */
export async function PUT(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid("Request body must be JSON.");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? "invalid request");
  }

  try {
    const box = await resolveWorkspaceBox({ userId: run.userId });
    const git = workspaceGit(box);
    const draft = await git.updatePullRequestDraft(parsed.data);
    return Response.json({ draft });
  } catch (error) {
    return gitErrorResponse(error);
  }
}
