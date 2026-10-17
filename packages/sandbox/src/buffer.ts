import type { ExecChunk } from "./index";

/**
 * Shared helpers for command output in sandbox adapters.
 */

/** Memory used by a single command's in-flight stdout/stderr before truncation. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
export const BUFFER_CAP_BYTES = HEAD_BYTES + TAIL_BYTES;

/**
 * Bounded byte-accurate chunk collector with head+tail semantics. Streams go
 * through this so a runaway command (or a paused consumer) can never balloon
 * process memory: the first `HEAD_BYTES` stay intact, everything beyond that is
 * folded into a `TAIL_BYTES` ring, and `drain()` returns head + `<truncated>`
 * marker + tail in order.
 */
export class ChunkBuffer {
  private head: ExecChunk[] = [];
  private headBytes = 0;
  private tail: ExecChunk[] = [];
  private tailBytes = 0;
  private truncated = false;

  push(chunk: ExecChunk): void {
    const bytes = Buffer.byteLength(chunk.data, "utf8");
    if (this.headBytes + bytes <= HEAD_BYTES) {
      this.head.push(chunk);
      this.headBytes += bytes;
      return;
    }
    this.truncated = true;
    // The head cap is exceeded: keep only what still fits in the head slice,
    // then fold the rest into the tail ring (a single chunk larger than the
    // ring is edited down to its last TAIL_BYTES so the newest output survives).
    let rest = chunk;
    if (this.headBytes < HEAD_BYTES) {
      const room = HEAD_BYTES - this.headBytes;
      this.head.push({ stream: chunk.stream, data: chunk.data.slice(0, room) });
      this.headBytes += room;
      rest = { stream: chunk.stream, data: chunk.data.slice(room) };
    }
    let restBytes = Buffer.byteLength(rest.data, "utf8");
    if (restBytes > TAIL_BYTES) {
      rest = { stream: rest.stream, data: rest.data.slice(restBytes - TAIL_BYTES) };
      restBytes = TAIL_BYTES;
    }
    this.tail.push(rest);
    this.tailBytes += restBytes;
    while (this.tailBytes > TAIL_BYTES) {
      const oldest = this.tail.shift();
      if (!oldest) break;
      this.tailBytes -= Buffer.byteLength(oldest.data, "utf8");
    }
  }

  get empty(): boolean {
    return this.head.length === 0 && this.tail.length === 0;
  }

  /** Emit everything held so far, resetting the collector. */
  drain(): ExecChunk[] {
    const out: ExecChunk[] = this.head;
    if (this.truncated) {
      out.push({
        stream: "stderr",
        data: `\n[output truncated: kept head ${HEAD_BYTES} + tail ${TAIL_BYTES} bytes]\n`,
      });
      out.push(...this.tail);
    }
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.truncated = false;
    return out;
  }
}

/** An `Error` whose `name` matches the platform `AbortError`, thrown on signal. */
export function abortError(message = "The operation was aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * Append a parseable exit-status marker as a final stderr chunk so consumers
 * that collapse stdout/stderr (the bash tool) still learn the exit code
 * without an interface change. Non-zero exits are marked; clean exits are not.
 */
export function exitMarker(exitCode: number): ExecChunk | undefined {
  if (exitCode === 0) return undefined;
  return {
    stream: "stderr",
    data: `\n[buildx: command exited with code ${exitCode}]\n`,
  };
}