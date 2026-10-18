import {
  markOutboxPublished,
  recordOutboxPublishFailure,
  type Db,
} from "@buildx/db";
import { getCloudflareBindings, type QueueBinding } from "../cloudflare/context";
import type { RunDispatchMessage } from "./types";

export interface DispatchRunOptions {
  db?: Db;
  queue?: QueueBinding;
}

/**
 * Dispatch a run execution message to Cloudflare Queues.
 * Atomically tied to the outbox message: marks outbox 'published' on success,
 * or records failure for reconciliation if publishing fails.
 */
export async function dispatchRunToQueue(
  message: RunDispatchMessage,
  options: DispatchRunOptions = {},
): Promise<boolean> {
  const correlationId = message.correlationId || message.runId;
  console.log(`[queue-producer][${correlationId}] dispatching run ${message.runId} to Cloudflare Queue`);
  const queue = options.queue ?? getCloudflareBindings().BUILDX_QUEUE;
  if (!queue) {
    console.warn(`[queue-producer][${correlationId}] no queue binding available`);
    return false;
  }

  try {
    await queue.send(message);
    console.log(`[queue-producer][${correlationId}] message sent to queue successfully for run ${message.runId}`);

    if (message.outboxId && options.db) {
      await markOutboxPublished(options.db, message.outboxId).catch((err) => {
        console.error(
          `[queue-producer][${correlationId}] failed to mark outbox ${message.outboxId} published`,
          err,
        );
      });
    }

    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[queue-producer][${correlationId}] failed to dispatch run ${message.runId} to queue:`,
      errorMsg,
    );

    if (message.outboxId && options.db) {
      await recordOutboxPublishFailure(options.db, {
        id: message.outboxId,
        error: errorMsg,
      }).catch((err) => {
        console.error(
          `[queue-producer][${correlationId}] failed to record outbox ${message.outboxId} failure:`,
          err,
        );
      });
    }

    return false;
  }
}
