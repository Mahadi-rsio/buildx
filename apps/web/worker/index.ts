// Custom Worker Entry Point wrapping OpenNext build output with Queue consumer handler.
// The file ../.open-next/worker.js is generated at build time by opennextjs-cloudflare.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - OpenNext worker is generated at build time
import openNextHandler from "../.open-next/worker.js";
import { handleQueueBatch, type QueueBatch } from "../lib/queue/consumer";
import type { RunDispatchMessage } from "../lib/queue/types";

export default {
  // Re-export Next.js HTTP/SSE fetch handler from OpenNext
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    return (openNextHandler as { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> }).fetch(request, env, ctx);
  },

  // Cloudflare Queue consumer entry point
  async queue(
    batch: QueueBatch<RunDispatchMessage>,
    _env: unknown,
    _ctx: unknown,
  ): Promise<void> {
    await handleQueueBatch(batch);
  },
};

