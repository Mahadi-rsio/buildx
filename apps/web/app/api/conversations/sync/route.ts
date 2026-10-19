import { conversationSyncSchema } from "@buildx/shared";
import {
  and,
  conversationEvents,
  conversations,
  eq,
  getDb,
  inArray,
  runs,
  sql,
} from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * `POST /api/conversations/sync` — idempotent batch upsert of locally queued
 * conversation messages. Event ids are client-generated, so retries and
 * duplicate tabs can safely replay the same batch.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const body = await request.json().catch(() => null);
  const parsed = conversationSyncSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { conversationId, events } = parsed.data;
  const db = getDb();

  try {
    const firstUserMessage = events.find((event) => event.role === "user");
    await db
      .insert(conversations)
      .values({
        id: conversationId,
        userId: user.id,
        title: firstUserMessage?.content.slice(0, 200) ?? null,
      })
      .onConflictDoNothing({ target: conversations.id });

    const [existing] = await db
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));

    if (!existing || existing.userId !== user.id) {
      return Response.json(
        { error: "conversation_conflict" },
        { status: 403 },
      );
    }

    // Only attach runs this user owns; an unknown/foreign id becomes null so a
    // single bad client value cannot fail the whole batch on the FK.
    const requestedRunIds = [
      ...new Set(
        events
          .map((event) => event.runId)
          .filter((runId): runId is string => Boolean(runId)),
      ),
    ];
    const ownedRunIds = new Set(
      requestedRunIds.length > 0
        ? (
            await db
              .select({ id: runs.id })
              .from(runs)
              .where(
                and(
                  eq(runs.userId, user.id),
                  inArray(runs.id, requestedRunIds),
                ),
              )
          ).map((row) => row.id)
        : [],
    );

    await db
      .insert(conversationEvents)
      .values(
        events.map((event) => ({
          id: event.id,
          conversationId,
          userId: user.id,
          runId:
            event.runId && ownedRunIds.has(event.runId)
              ? event.runId
              : null,
          role: event.role,
          kind: event.kind,
          content: event.content,
          seq: event.seq,
          clientCreatedAt: new Date(event.createdAt),
        })),
      )
      .onConflictDoNothing();

    await db
      .update(conversations)
      .set({
        updatedAt: new Date(),
        title: sql`coalesce(${conversations.title}, ${firstUserMessage?.content.slice(0, 200) ?? null})`,
      })
      .where(eq(conversations.id, conversationId));

    return Response.json({
      conversationId,
      synced: events.length,
      ids: events.map((event) => event.id),
    });
  } catch (error: unknown) {
    console.error("[POST /api/conversations/sync] error:", error);
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return Response.json(
      { error: "internal_error", message },
      { status: 500 },
    );
  }
}
