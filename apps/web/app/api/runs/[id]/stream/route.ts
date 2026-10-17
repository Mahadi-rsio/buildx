import type { RunEvent } from "@buildx/shared";
import { isTerminalStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

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

/**
 * `GET /api/runs/:id/stream?after=<eventId>` — replays events after `after`
 * (arcetecture.md §5.2), then pushes live appends until the run is terminal.
 * Reconnects resume from the browser's `Last-Event-ID` header, which takes
 * precedence over the initial `?after` so a reconnect never re-replays.
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

  let detach = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const close = (): void => {
        if (closed) return;
        closed = true;
        detach();
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
        if (event.type === "status" && isTerminalStatus(event.data.status)) {
          close();
        }
      };

      for (const event of run.events) {
        if (event.id > after) send(event);
      }
      if (closed || isTerminalStatus(run.status)) {
        close();
        return;
      }

      const onEvent = (event: RunEvent): void => send(event);
      run.subscribers.add(onEvent);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          close();
        }
      }, 15_000);

      detach = (): void => {
        run.subscribers.delete(onEvent);
        clearInterval(heartbeat);
      };
    },
    cancel() {
      detach();
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
