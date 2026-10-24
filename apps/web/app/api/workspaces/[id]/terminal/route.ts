import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { tryGetWorkspaceBox } from "@/lib/sandbox";
import {
  acquireTerminalSlot,
  canAccessWorkspace,
  parseTerminalRequest,
  registerTerminalSession,
  removeTerminalSession,
  startTerminalSession,
  type TerminalRecord,
} from "@/lib/terminal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, message: detail }, { status });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * `POST /api/workspaces/:id/terminal` — open one live shell session in the
 * user's existing Upstash Box workspace and stream its output as NDJSON.
 *
 * The response starts with `{type:"session",id,pid}`; stdin, resize and signals
 * are sent to `/api/workspaces/:id/terminal/:sessionId`. Opening the panel only
 * does read-only lookups; a box is resumed (or created) only by this explicit
 * POST, through `ensureRunning()`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON.", 400);
  }
  const parsed = parseTerminalRequest(body);
  if (!parsed.ok) {
    return jsonError("invalid_body", parsed.error, 400);
  }

  const run = await findOwnedRun(id, user.id);
  if (!run || !canAccessWorkspace(run.userId, user.id)) return notFound(id);

  let box;
  try {
    box = await tryGetWorkspaceBox(run.userId, run.workspaceId);
  } catch (error) {
    return jsonError(
      "workspace_unavailable",
      `Could not reach the workspace: ${message(error)}`,
      503,
    );
  }
  if (!box) {
    return jsonError(
      "workspace_not_ready",
      "This workspace has no box yet. Start a run to create it before using the terminal.",
      409,
    );
  }

  const release = acquireTerminalSlot(run.userId);
  if (!release) {
    return jsonError(
      "terminal_busy",
      "A terminal session is already running for this workspace.",
      409,
    );
  }

  try {
    await box.ensureRunning();
  } catch (error) {
    release();
    return jsonError(
      "workspace_not_ready",
      `The workspace could not be resumed: ${message(error)}`,
      409,
    );
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", onAbort, { once: true });

  let session;
  try {
    session = await startTerminalSession({
      sandbox: box,
      command: parsed.value.command,
      cwd: parsed.value.cwd,
      timeoutMs: parsed.value.timeoutMs,
      tty: parsed.value.tty,
      rows: parsed.value.rows,
      cols: parsed.value.cols,
      signal: controller.signal,
    });
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    release();
    if (isAbortError(error) || controller.signal.aborted) {
      return jsonError("cancelled", "The terminal request was cancelled.", 499);
    }
    return jsonError(
      "terminal_failed",
      `Could not start the terminal session: ${message(error)}`,
      503,
    );
  }

  registerTerminalSession({
    id: session.sessionId,
    userId: run.userId,
    runId: id,
    handle: session.handle,
    stop: session.stop,
    startedAt: Date.now(),
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      try {
        for await (const record of session.records) {
          streamController.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
        }
      } catch (error) {
        const failure: TerminalRecord = {
          type: "error",
          code: "command_failed",
          message: message(error),
        };
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(failure)}\n`));
        } catch {
          // Client already disconnected.
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        removeTerminalSession(run.userId, session.sessionId);
        release();
        try {
          streamController.close();
        } catch {
          // Stream already cancelled.
        }
      }
    },
    cancel() {
      controller.abort();
      session.stop();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}
