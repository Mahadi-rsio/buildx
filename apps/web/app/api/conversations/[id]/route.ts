import {
  conversationEvents,
  conversations,
  asc,
  eq,
  getDb,
} from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/** `GET /api/conversations/:id` — conversation metadata plus its messages. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { id } = await params;

  try {
    const db = getDb();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));

    if (!conversation || conversation.userId !== user.id) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const events = await db
      .select({
        id: conversationEvents.id,
        role: conversationEvents.role,
        kind: conversationEvents.kind,
        content: conversationEvents.content,
        seq: conversationEvents.seq,
        createdAt: conversationEvents.clientCreatedAt,
      })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id))
      .orderBy(asc(conversationEvents.seq));

    return Response.json({ conversation, events });
  } catch (error: unknown) {
    console.error("[GET /api/conversations/:id] error:", error);
    return Response.json(
      { error: "internal_error" },
      { status: 500 },
    );
  }
}
