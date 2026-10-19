"use client";

/**
 * Local-first conversation sync.
 *
 * Messages are written to localStorage the moment they happen and flashed to
 * the server in 30s batches. A pending entry is removed only after the server
 * acknowledges it, so a reload (or a network drop) never loses a message and a
 * retry never duplicates one (event `id` is the uniqueness key).
 */

export const PENDING_QUEUE_KEY = "buildx.conversation.pending.v1";
export const SYNC_INTERVAL_MS = 30_000;
export const SYNC_REQUEST_EVENT = "buildx:conversation-sync-request";

const MAX_QUEUE = 1_000;
const MAX_BATCH = 200;
const MAX_BACKOFF_MS = 30_000;

export interface PendingConversationEvent {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  kind: "message";
  createdAt: number;
  runId?: string;
}

interface PersistedQueue {
  events: PendingConversationEvent[];
  failures: number;
  nextAttemptAt: number;
}

const EMPTY_QUEUE: PersistedQueue = { events: [], failures: 0, nextAttemptAt: 0 };

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPendingQueue(): PendingConversationEvent[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(PENDING_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedQueue>;
    if (!Array.isArray(parsed.events)) return [];
    return parsed.events.filter(
      (event): event is PendingConversationEvent =>
        typeof event?.id === "string" &&
        typeof event?.conversationId === "string" &&
        typeof event?.seq === "number" &&
        (event?.role === "user" || event?.role === "assistant") &&
        typeof event?.content === "string" &&
        typeof event?.createdAt === "number" &&
        (event?.runId === undefined || typeof event?.runId === "string"),
    );
  } catch {
    return [];
  }
}

function writeQueue(queue: PersistedQueue): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PENDING_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Quota/serialization failure: keep the in-memory copy usable.
  }
}

function readState(): PersistedQueue {
  const events = readPendingQueue();
  const store = storage();
  let failures = 0;
  let nextAttemptAt = 0;
  if (store) {
    try {
      const raw = store.getItem(PENDING_QUEUE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedQueue>;
        failures = typeof parsed.failures === "number" ? parsed.failures : 0;
        nextAttemptAt =
          typeof parsed.nextAttemptAt === "number" ? parsed.nextAttemptAt : 0;
      }
    } catch {
      // Ignore malformed metadata.
    }
  }
  return { events, failures, nextAttemptAt };
}

export function pendingEventId(
  conversationId: string,
  runId: string,
  role: "user" | "assistant",
): string {
  return role === "assistant"
    ? `${runId}:assistant`
    : `${conversationId}:user:${runId}`;
}

/** Next monotonic sequence for a conversation based on the local queue. */
export function nextSeq(conversationId: string, floor = 0): number {
  let seq = floor;
  for (const event of readPendingQueue()) {
    if (event.conversationId === conversationId && event.seq >= seq) {
      seq = event.seq + 1;
    }
  }
  return seq;
}

export function enqueueConversationEvent(
  event: PendingConversationEvent,
): void {
  const state = readState();
  const existing = state.events.findIndex((item) => item.id === event.id);
  if (existing >= 0) {
    state.events[existing] = event;
  } else {
    state.events.push(event);
  }
  if (state.events.length > MAX_QUEUE) {
    state.events = state.events.slice(state.events.length - MAX_QUEUE);
  }
  writeQueue(state);
  requestConversationSync();
}

/** Ask the mounted sync loop to flush now (no-op when nothing is listening). */
export function requestConversationSync(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SYNC_REQUEST_EVENT));
}

export function clearPendingConversationQueue(): void {
  writeQueue({ ...EMPTY_QUEUE });
}

let inFlight: Promise<void> | null = null;

/**
 * Flush queued events to `POST /api/conversations/sync`. Single-flight per tab;
 * removes acked ids only, and backs off (bounded) on transport failures.
 */
export function flushConversationSync(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runFlush().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(): Promise<void> {
  const state = readState();
  if (state.events.length === 0) return;
  if (state.nextAttemptAt > Date.now()) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  const byConversation = new Map<string, PendingConversationEvent[]>();
  for (const event of state.events) {
    const group = byConversation.get(event.conversationId);
    if (group) group.push(event);
    else byConversation.set(event.conversationId, [event]);
  }

  const acked = new Set<string>();
  let sawRetryableFailure = false;

  for (const [conversationId, group] of byConversation) {
    const batch = group.slice(0, MAX_BATCH);
    try {
      const res = await fetch("/api/conversations/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          events: batch.map(
            ({ id, seq, role, content, kind, createdAt, runId }) => ({
              id,
              seq,
              role,
              content,
              kind,
              createdAt,
              runId,
            }),
          ),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { ids?: string[] };
        for (const id of data.ids ?? batch.map((event) => event.id)) {
          acked.add(id);
        }
        continue;
      }
      if (res.status === 401) {
        // Session may return; keep the queue for the next flush.
        sawRetryableFailure = true;
      } else if (res.status === 429 || res.status >= 500) {
        sawRetryableFailure = true;
      } else {
        // 4xx (400/403/404) will not succeed on retry; drop the batch so it
        // cannot wedge every later message behind it.
        for (const event of batch) acked.add(event.id);
      }
    } catch {
      sawRetryableFailure = true;
    }
  }

  if (acked.size > 0) {
    const remaining = readState();
    writeQueue({
      ...remaining,
      events: remaining.events.filter((event) => !acked.has(event.id)),
    });
  }

  if (sawRetryableFailure) {
    const current = readState();
    const failures = current.failures + 1;
    writeQueue({
      ...current,
      failures,
      nextAttemptAt: Date.now() + Math.min(2 ** failures * 1_000, MAX_BACKOFF_MS),
    });
    return;
  }

  // Success path: clear backoff.
  const settled = readState();
  if (settled.failures !== 0 || settled.nextAttemptAt !== 0) {
    writeQueue({ ...settled, failures: 0, nextAttemptAt: 0 });
  }
}
