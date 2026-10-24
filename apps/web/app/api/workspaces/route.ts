import { and, eq, getDb, workspaces } from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { provisionWorkspaceBox } from "@/lib/workspace-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAME_MIN = 2;
const NAME_MAX = 40;

function toWorkspace(row: {
  id: string;
  name: string;
  status: string;
  box_id: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    provisioned: Boolean(row.box_id) && row.status === "ready",
  };
}

/** List only the authenticated user's workspaces. */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  try {
    const rows = await getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, user.id))
      .orderBy(workspaces.createdAt);
    return Response.json({ workspaces: rows.map(toWorkspace) });
  } catch (error) {
    console.error("[GET /api/workspaces] failed", error);
    return Response.json(
      { error: "workspace_list_failed", message: "Could not load workspaces." },
      { status: 500 },
    );
  }
}

/** Create a named workspace and provision its dedicated Small Upstash Box. */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; size?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";

  if (
    name.length < NAME_MIN ||
    name.length > NAME_MAX ||
    /[\u0000-\u001f/\\]/.test(name)
  ) {
    return Response.json(
      {
        error: "invalid_workspace_name",
        message: `Workspace name must be ${NAME_MIN}–${NAME_MAX} characters and cannot contain slashes.`,
      },
      { status: 400 },
    );
  }

  // The public UI displays paid tiers, but this endpoint deliberately accepts
  // only Small until the account's paid-plan entitlement is implemented.
  if (body?.size !== undefined && body.size !== "small") {
    return Response.json(
      {
        error: "plan_required",
        message: "Only the Small 4 GB RAM / 5 GB storage Box is available on the free plan.",
      },
      { status: 403 },
    );
  }

  const db = getDb();
  let workspaceId: string | undefined;
  try {
    const [existing] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, user.id), eq(workspaces.name, name)))
      .limit(1);

    if (existing?.status === "ready" && existing.box_id) {
      return Response.json({ workspace: toWorkspace(existing) }, { status: 200 });
    }

    if (existing) {
      workspaceId = existing.id;
      await db
        .update(workspaces)
        .set({ status: "provisioning", updatedAt: new Date() })
        .where(and(eq(workspaces.id, existing.id), eq(workspaces.userId, user.id)));
    } else {
      const [created] = await db
        .insert(workspaces)
        .values({ userId: user.id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), status: "provisioning" })
        .returning({ id: workspaces.id });
      workspaceId = created.id;
    }

    await provisionWorkspaceBox(workspaceId, user.id);
    const [ready] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, user.id)))
      .limit(1);

    if (!ready) throw new Error("Workspace row disappeared after provisioning.");
    return Response.json({ workspace: toWorkspace(ready) }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/workspaces] provisioning failed", error);
    if (workspaceId) {
      await db.update(workspaces)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, user.id)))
        .catch(() => undefined);
    }
    return Response.json(
      {
        error: "workspace_provisioning_failed",
        message: "Workspace creation failed. No run was started; retry creation in a moment.",
      },
      { status: 500 },
    );
  }
}
