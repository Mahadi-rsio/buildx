import type { RunEvent } from "@buildx/shared";
import { isTerminalStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import { getRun, listEventsAfter } from "@/lib/store";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const POLL_MS = 1_000;

/**
 * One SSE frame. `id` lets EventSource resume via `Last-Event-ID`; `data` wraps
 * the payload as `{ ts, data }` so the client keeps the server timestamp while
 * `@buildx/shared` owns the payload contract.
 */
function frame(event: RunEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
      ts: event.ts,
      data: event.data,
    })}\n\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for one in-process append (fast path when this process is executing the
 * run) or the poll interval, whichever comes first — the DB poll is always the
 * source of truth across instances.
 */
function waitForWake(run: Awaited<ReturnType<typeof getRun>>): Promise<void> {
  return new Promise((resolve) => {
    const onEvent = (): void => {
      run?.runtime.subscribers.delete(onEvent);
      resolve();
    };
    run?.runtime.subscribers.add(onEvent);
    void sleep(POLL_MS).then(onEvent);
  });
}

/**
 * `GET /api/runs/:id/stream?after=<eventId>` — replays events after `after`
 * (arcetecture.md §5.2), then pushes live appends until the run is terminal.
 * Events are read straight from Postgres so any worker instance's appends are
 * visible; a process-local subscriber speeds up delivery when this process
 * happens to be the one executing the run. Reconnects resume from the browser's
 * `Last-Event-ID` header, which takes precedence over the initial `?after` so a
 * reconnect never re-replays.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  const url = new URL(request.url);
  const resume = request.headers.get("last-event-id");
  const after = Number(resume ?? url.searchParams.get("after") ?? "0") || 0;

  // Fast-path subject: the run object (and its live SSE subscribers) when this
  // process has it cached, otherwise `undefined` → pure-poll mode.
  const subject = await getRun(id);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cursor = after;

      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Stream already cancelled by the client.
        }
      };

      const send = (event: RunEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(frame(event));
        } catch {
          close();
          return;
        }
        cursor = event.id;
        if (event.type === "status" && isTerminalStatus(event.data.status)) {
          close();
        }
      };

      const tick = async (): Promise<void> => {
        const snapshot = await listEventsAfter(id, cursor);
        for (const event of snapshot.events) {
          if (closed) return;
          send(event);
        }
        if (!closed && isTerminalStatus(snapshot.status)) close();
      };

      try {
        await tick();
        while (!closed) {
          await waitForWake(subject);
          await tick();
        }
      } catch {
        close();
      }
    },
    cancel() {
      // No-op: queued poll ticks fall through on their own timeout.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}