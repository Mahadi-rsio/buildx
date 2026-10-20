import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { notFound } from "@/lib/authz";
import {
  getTerminalSession,
  parseTerminalInput,
  removeTerminalSession,
} from "@/lib/terminal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `POST /api/workspaces/:id/terminal/:sessionId` — write stdin, resize the PTY,
 * or send a signal to a live terminal session owned by the caller.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const { id, sessionId } = await params;
  const entry = getTerminalSession(user.id, id, sessionId);
  if (!entry) return notFound(sessionId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_body", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  const parsed = parseTerminalInput(body);
  if (!parsed.ok) {
    return Response.json(
      { error: "invalid_body", message: parsed.error },
      { status: 400 },
    );
  }

  try {
    if (parsed.value.type === "stdin") {
      entry.handle.write(parsed.value.data);
    } else if (parsed.value.type === "resize") {
      entry.handle.resize(parsed.value.rows, parsed.value.cols);
    } else {
      entry.handle.kill(parsed.value.signal);
    }
  } catch (error) {
    return Response.json(
      { error: "terminal_closed", message: message(error) },
      { status: 409 },
    );
  }

  return Response.json({ ok: true });
}

/** Close the session and terminate its process. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const { id, sessionId } = await params;
  const entry = getTerminalSession(user.id, id, sessionId);
  if (!entry) return notFound(sessionId);

  entry.stop();
  removeTerminalSession(user.id, sessionId);
  return new Response(null, { status: 204 });
}
