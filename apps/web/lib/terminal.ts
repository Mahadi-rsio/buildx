import { randomUUID } from "node:crypto";
import type {
  ExecChunk,
  Sandbox,
  SessionHandle,
  SessionSignal,
} from "@buildx/sandbox";

export const TERMINAL_MAX_COMMAND_CHARS = 8_000;
export const TERMINAL_DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const TERMINAL_MIN_TIMEOUT_MS = 1_000;
export const TERMINAL_MAX_TIMEOUT_MS = 60 * 60_000;
export const TERMINAL_MAX_OUTPUT_BYTES = 512 * 1024;
export const TERMINAL_MAX_INPUT_CHARS = 64 * 1024;
export const TERMINAL_MAX_ROWS = 200;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MAX_SESSIONS_PER_USER = 4;

export type TerminalErrorCode =
  | "timeout"
  | "cancelled"
  | "command_failed"
  | "session_unavailable";

export type TerminalRecord =
  | { type: "start"; command: string; tty: boolean }
  | { type: "session"; id: string; pid: number }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "truncated"; message: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; code: TerminalErrorCode; message: string };

export interface TerminalRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  tty: boolean;
  rows?: number;
  cols?: number;
}

export type TerminalRequestResult =
  | { ok: true; value: TerminalRequest }
  | { ok: false; error: string };

export type TerminalInput =
  | { type: "stdin"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "signal"; signal: SessionSignal };

export type TerminalInputResult =
  | { ok: true; value: TerminalInput }
  | { ok: false; error: string };

const SESSION_SIGNALS: readonly SessionSignal[] = [
  "TERM",
  "KILL",
  "INT",
  "HUP",
  "TSTP",
  "QUIT",
  "USR1",
  "USR2",
];

/** Ownership check used by the terminal route (in addition to findOwnedRun). */
export function canAccessWorkspace(runUserId: string, userId: string): boolean {
  return runUserId.length > 0 && runUserId === userId;
}

export function clampTerminalTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return TERMINAL_DEFAULT_TIMEOUT_MS;
  return Math.min(
    TERMINAL_MAX_TIMEOUT_MS,
    Math.max(TERMINAL_MIN_TIMEOUT_MS, Math.floor(timeoutMs)),
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseTerminalRequest(body: unknown): TerminalRequestResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  const command = record.command;
  if (typeof command !== "string") {
    return { ok: false, error: "command must be a string" };
  }
  if (command.length === 0 || command.length > TERMINAL_MAX_COMMAND_CHARS) {
    return {
      ok: false,
      error: `command must be 1..${TERMINAL_MAX_COMMAND_CHARS} characters`,
    };
  }
  if (command.trim().length === 0) {
    return { ok: false, error: "command must not be blank" };
  }

  const rawCwd = record.cwd;
  let cwd: string | undefined;
  if (rawCwd !== undefined) {
    if (typeof rawCwd !== "string" || rawCwd.length > 1_024) {
      return { ok: false, error: "cwd must be a workspace-relative string" };
    }
    const normalized = rawCwd.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      return { ok: false, error: "cwd must stay inside the workspace" };
    }
    cwd = rawCwd;
  }

  const rawTimeout = record.timeoutMs;
  if (rawTimeout !== undefined && !isFiniteNumber(rawTimeout)) {
    return { ok: false, error: "timeoutMs must be a finite number" };
  }

  const rawTty = record.tty;
  if (rawTty !== undefined && typeof rawTty !== "boolean") {
    return { ok: false, error: "tty must be a boolean" };
  }

  const rawRows = record.rows;
  if (
    rawRows !== undefined &&
    (!isFiniteNumber(rawRows) || rawRows < 1 || rawRows > TERMINAL_MAX_ROWS)
  ) {
    return { ok: false, error: `rows must be 1..${TERMINAL_MAX_ROWS}` };
  }

  const rawCols = record.cols;
  if (
    rawCols !== undefined &&
    (!isFiniteNumber(rawCols) || rawCols < 1 || rawCols > TERMINAL_MAX_COLS)
  ) {
    return { ok: false, error: `cols must be 1..${TERMINAL_MAX_COLS}` };
  }

  return {
    ok: true,
    value: {
      command,
      tty: rawTty ?? true,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(rawTimeout !== undefined ? { timeoutMs: rawTimeout } : {}),
      ...(rawRows !== undefined ? { rows: Math.floor(rawRows) } : {}),
      ...(rawCols !== undefined ? { cols: Math.floor(rawCols) } : {}),
    },
  };
}

export function parseTerminalInput(body: unknown): TerminalInputResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  const type = record.type;

  if (type === "stdin") {
    if (typeof record.data !== "string") {
      return { ok: false, error: "data must be a string" };
    }
    if (record.data.length > TERMINAL_MAX_INPUT_CHARS) {
      return {
        ok: false,
        error: `data must be at most ${TERMINAL_MAX_INPUT_CHARS} characters`,
      };
    }
    return { ok: true, value: { type: "stdin", data: record.data } };
  }

  if (type === "resize") {
    if (
      !isFiniteNumber(record.rows) ||
      record.rows < 1 ||
      record.rows > TERMINAL_MAX_ROWS
    ) {
      return { ok: false, error: `rows must be 1..${TERMINAL_MAX_ROWS}` };
    }
    if (
      !isFiniteNumber(record.cols) ||
      record.cols < 1 ||
      record.cols > TERMINAL_MAX_COLS
    ) {
      return { ok: false, error: `cols must be 1..${TERMINAL_MAX_COLS}` };
    }
    return {
      ok: true,
      value: {
        type: "resize",
        rows: Math.floor(record.rows),
        cols: Math.floor(record.cols),
      },
    };
  }

  if (type === "signal") {
    const raw = record.signal;
    const signal =
      typeof raw === "string" ? (raw.toUpperCase() as SessionSignal) : null;
    if (!signal || !SESSION_SIGNALS.includes(signal)) {
      return {
        ok: false,
        error: `signal must be one of ${SESSION_SIGNALS.join(", ")}`,
      };
    }
    return { ok: true, value: { type: "signal", signal } };
  }

  return { ok: false, error: "type must be stdin, resize, or signal" };
}

interface TerminalRegistry {
  active: Map<string, Set<symbol>>;
  sessions: Map<string, TerminalSessionEntry>;
}

export interface TerminalSessionEntry {
  id: string;
  userId: string;
  runId: string;
  handle: SessionHandle;
  stop: () => void;
  startedAt: number;
}

const globalTerminalState = globalThis as unknown as {
  __BUILDX_TERMINAL_ACTIVE__?: TerminalRegistry;
};

function registry(): TerminalRegistry {
  if (!globalTerminalState.__BUILDX_TERMINAL_ACTIVE__) {
    globalTerminalState.__BUILDX_TERMINAL_ACTIVE__ = {
      active: new Map(),
      sessions: new Map(),
    };
  }
  return globalTerminalState.__BUILDX_TERMINAL_ACTIVE__;
}

function sessionKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

/**
 * Claim one of a user's terminal slots (one per open tab). Returns a release
 * function, or `undefined` once all slots are in use.
 */
export function acquireTerminalSlot(userId: string): (() => void) | undefined {
  const { active } = registry();
  const tokens = active.get(userId) ?? new Set<symbol>();
  if (tokens.size >= TERMINAL_MAX_SESSIONS_PER_USER) return undefined;
  const token = Symbol(userId);
  tokens.add(token);
  active.set(userId, tokens);
  return () => {
    tokens.delete(token);
    if (tokens.size === 0) active.delete(userId);
  };
}

export function isTerminalActive(userId: string): boolean {
  return (registry().active.get(userId)?.size ?? 0) > 0;
}

export function registerTerminalSession(entry: TerminalSessionEntry): void {
  registry().sessions.set(sessionKey(entry.userId, entry.id), entry);
}

export function getTerminalSession(
  userId: string,
  runId: string,
  id: string,
): TerminalSessionEntry | undefined {
  const entry = registry().sessions.get(sessionKey(userId, id));
  if (!entry || entry.runId !== runId) return undefined;
  return entry;
}

export function removeTerminalSession(userId: string, id: string): void {
  registry().sessions.delete(sessionKey(userId, id));
}

export function resetTerminalRegistryForTest(): void {
  registry().active.clear();
  registry().sessions.clear();
}

class OutputQueue implements AsyncIterable<ExecChunk> {
  private items: ExecChunk[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  push(chunk: ExecChunk): void {
    if (this.ended) return;
    this.items.push(chunk);
    this.wake?.();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ExecChunk> {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function takeBytes(
  text: string,
  remaining: number,
): { piece: string; consumed: number; exceeded: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= remaining) return { piece: text, consumed: bytes, exceeded: false };
  const piece = Buffer.from(text, "utf8")
    .subarray(0, Math.max(0, remaining))
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return {
    piece,
    consumed: Buffer.byteLength(piece, "utf8"),
    exceeded: true,
  };
}

export interface StartTerminalSessionOptions {
  sandbox: Pick<Sandbox, "openSession">;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  tty?: boolean;
  rows?: number;
  cols?: number;
  signal?: AbortSignal;
}

export interface TerminalSessionRun {
  sessionId: string;
  pid: number;
  handle: SessionHandle;
  stop: () => void;
  records: AsyncGenerator<TerminalRecord>;
}

/**
 * Start a live terminal session and return an NDJSON-friendly record stream.
 *
 * The Box session API is WebSocket-backed: output starts flowing through
 * callbacks before `openSession()` resolves, so records are queued until the
 * consumer iterates. Sessions are Node-only and not reattachable; closing the
 * handle (or losing the network) terminates the process.
 */
export async function startTerminalSession(
  options: StartTerminalSessionOptions,
): Promise<TerminalSessionRun> {
  const timeoutMs = clampTerminalTimeout(options.timeoutMs);
  const tty = options.tty ?? true;
  const sessionId = randomUUID();
  const queue = new OutputQueue();

  let handle: SessionHandle | undefined;
  let timedOut = false;
  let cancelled = options.signal?.aborted === true;
  let truncated = false;
  let exitCode: number | undefined;
  let waitError: Error | undefined;

  if (cancelled) {
    throw Object.assign(new Error("terminal cancelled"), { name: "AbortError" });
  }

  let killed = false;
  const killOnce = (signal: SessionSignal = "KILL"): void => {
    if (killed) return;
    killed = true;
    try {
      handle?.kill(signal);
    } catch {
      // Process may already have exited.
    }
  };

  const timer = setTimeout(() => {
    if (timedOut || cancelled) return;
    timedOut = true;
    queue.end();
    try {
      handle?.terminate(1_000);
    } catch {
      // Process may already have exited.
    }
  }, timeoutMs);

  const stop = (): void => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
    queue.end();
    killOnce("KILL");
  };

  const onAbort = (): void => stop();

  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    handle = await options.sandbox.openSession?.({
      cmd: options.command,
      cwd: options.cwd,
      tty,
      ...(options.rows ? { rows: options.rows } : {}),
      ...(options.cols ? { cols: options.cols } : {}),
      onOutput: (chunk) => queue.push(chunk),
    });
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (isAbortError(error) || options.signal?.aborted) {
      throw Object.assign(new Error("terminal cancelled"), { name: "AbortError" });
    }
    throw error;
  }

  if (!handle) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    throw new Error("This workspace backend does not support live terminal sessions.");
  }

  const activeHandle = handle;
  if (cancelled) {
    killOnce("KILL");
  } else if (timedOut) {
    try {
      activeHandle.terminate(1_000);
    } catch {
      // Process may already have exited.
    }
  } else {
    void activeHandle
      .wait()
      .then((code) => {
        exitCode = code;
        queue.end();
      })
      .catch((error: unknown) => {
        waitError = error instanceof Error ? error : new Error(String(error));
        queue.end();
      });
  }

  async function* records(): AsyncGenerator<TerminalRecord> {
    yield { type: "start", command: options.command, tty };
    yield { type: "session", id: sessionId, pid: activeHandle.pid };

    let outputBytes = 0;
    try {
      for await (const chunk of queue) {
        if (timedOut || cancelled) break;
        const remaining = TERMINAL_MAX_OUTPUT_BYTES - outputBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const sliced = takeBytes(chunk.data, remaining);
        if (sliced.piece.length > 0) {
          outputBytes += sliced.consumed;
          yield {
            type: chunk.stream === "stdout" ? "stdout" : "stderr",
            data: sliced.piece,
          };
        }
        if (sliced.exceeded) {
          truncated = true;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut || cancelled || truncated) {
        killOnce("KILL");
      }
      try {
        activeHandle.close();
      } catch {
        // The connection may already be gone.
      }
    }

    if (truncated) {
      yield {
        type: "truncated",
        message: `Output exceeded ${TERMINAL_MAX_OUTPUT_BYTES} bytes; session stopped.`,
      };
      return;
    }
    if (timedOut) {
      yield {
        type: "error",
        code: "timeout",
        message: `Session timed out after ${timeoutMs}ms.`,
      };
      return;
    }
    if (cancelled) {
      yield { type: "error", code: "cancelled", message: "Session cancelled." };
      return;
    }
    if (waitError) {
      yield {
        type: "error",
        code: "command_failed",
        message: message(waitError),
      };
      return;
    }
    if (exitCode === undefined) {
      try {
        exitCode = await activeHandle.wait();
      } catch (error) {
        yield {
          type: "error",
          code: "command_failed",
          message: message(error),
        };
        return;
      }
    }
    yield { type: "exit", exitCode };
  }

  return {
    sessionId,
    pid: activeHandle.pid,
    handle: activeHandle,
    stop,
    records: records(),
  };
}
