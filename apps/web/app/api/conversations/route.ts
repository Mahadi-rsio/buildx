import { conversations, desc, eq, getDb } from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/** `GET /api/conversations` — the caller's most recent conversations. */
export async function GET(request?: Request): Promise<Response> {
  const user = await getCurrentUser(request?.headers);
  if (!user) return unauthorized();

  try {
    const rows = await getDb()
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.userId, user.id))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);

    return Response.json({ conversations: rows });
  } catch (error: unknown) {
    console.error("[GET /api/conversations] error:", error);
    return Response.json(
      { error: "internal_error", conversations: [] },
      { status: 500 },
    );
  }
}
