import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionHandle,
  SessionOptions,
  SessionSignal,
} from "@buildx/sandbox";
import {
  TERMINAL_MAX_OUTPUT_BYTES,
  acquireTerminalSlot,
  canAccessWorkspace,
  clampTerminalTimeout,
  getTerminalSession,
  parseTerminalInput,
  parseTerminalRequest,
  registerTerminalSession,
  removeTerminalSession,
  resetTerminalRegistryForTest,
  startTerminalSession,
  type TerminalRecord,
} from "./terminal";

class FakeSession implements SessionHandle {
  readonly pid = 4242;
  readonly execId = "exec-1";
  readonly writes: string[] = [];
  readonly signals: SessionSignal[] = [];
  readonly resizes: [number, number][] = [];
  closed = false;
  terminated = false;
  private resolveWait: ((code: number) => void) | undefined;
  private exited = false;

  constructor(private readonly options: SessionOptions) {}

  emit(stream: "stdout" | "stderr", data: string): void {
    this.options.onOutput?.({ stream, data });
  }

  exit(code = 0): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveWait?.(code);
  }

  write(data: string | Uint8Array): void {
    this.writes.push(typeof data === "string" ? data : Buffer.from(data).toString());
  }

  endStdin(): void {
    this.writes.push("<EOF>");
  }

  resize(rows: number, cols: number): void {
    this.resizes.push([rows, cols]);
  }

  kill(signal: SessionSignal = "TERM"): void {
    this.signals.push(signal);
    this.exit(143);
  }

  terminate(): void {
    this.terminated = true;
    this.exit(143);
  }

  wait(): Promise<number> {
    if (this.exited) return Promise.resolve(143);
    return new Promise<number>((resolve) => {
      this.resolveWait = resolve;
    });
  }

  close(): void {
    this.closed = true;
    this.exit(-1);
  }

  optionsUsed(): SessionOptions {
    return this.options;
  }
}

class FakeSandbox {
  session: FakeSession | undefined;

  async openSession(options: SessionOptions): Promise<SessionHandle> {
    this.session = new FakeSession(options);
    return this.session;
  }
}

function sink(): FakeSandbox {
  return new FakeSandbox();
}

async function collect(
  iterator: AsyncIterable<TerminalRecord>,
): Promise<TerminalRecord[]> {
  const records: TerminalRecord[] = [];
  for await (const record of iterator) records.push(record);
  return records;
}

test("starts a live session and streams output plus its exit code", async () => {
  const sandbox = sink();
  const run = await startTerminalSession({
    sandbox,
    command: "npm test",
    cwd: "app",
    tty: true,
    rows: 30,
    cols: 100,
  });

  const session = sandbox.session;
  assert.ok(session);
  assert.equal(session.optionsUsed().cmd, "npm test");
  assert.equal(session.optionsUsed().cwd, "app");
  assert.equal(session.optionsUsed().tty, true);
  assert.equal(session.optionsUsed().rows, 30);
  assert.equal(session.optionsUsed().cols, 100);

  session.emit("stdout", "hello\n");
  session.emit("stderr", "warn\n");
  session.exit(3);

  const records = await collect(run.records);
  assert.deepEqual(records[0], { type: "start", command: "npm test", tty: true });
  assert.deepEqual(records[1], { type: "session", id: run.sessionId, pid: 4242 });
  assert.deepEqual(records[2], { type: "stdout", data: "hello\n" });
  assert.deepEqual(records[3], { type: "stderr", data: "warn\n" });
  assert.deepEqual(records.at(-1), { type: "exit", exitCode: 3 });
  assert.equal(session.closed, true);
});

test("cancellation kills the session and reports it distinctly", async () => {
  const sandbox = sink();
  const controller = new AbortController();
  const run = await startTerminalSession({
    sandbox,
    command: "sleep 100",
    signal: controller.signal,
  });

  const recordsPromise = collect(run.records);
  controller.abort();

  const records = await recordsPromise;
  assert.deepEqual(records.at(-1), {
    type: "error",
    code: "cancelled",
    message: "Session cancelled.",
  });
  assert.deepEqual(sandbox.session?.signals, ["KILL"]);
});

test("stop() terminates a session through the registry handle", async () => {
  resetTerminalRegistryForTest();
  const sandbox = sink();
  const run = await startTerminalSession({ sandbox, command: "top" });
  registerTerminalSession({
    id: run.sessionId,
    userId: "user-1",
    runId: "run-1",
    handle: run.handle,
    stop: run.stop,
    startedAt: Date.now(),
  });

  const entry = getTerminalSession("user-1", "run-1", run.sessionId);
  assert.ok(entry);
  entry.handle.write("q");
  entry.handle.resize(40, 120);
  entry.handle.kill("INT");
  entry.stop();
  removeTerminalSession("user-1", run.sessionId);

  assert.equal(getTerminalSession("user-1", "run-1", run.sessionId), undefined);
  assert.deepEqual(sandbox.session?.writes, ["q"]);
  assert.deepEqual(sandbox.session?.resizes, [[40, 120]]);
  assert.deepEqual(sandbox.session?.signals, ["INT", "KILL"]);
  resetTerminalRegistryForTest();
});

test("truncates oversized output and stops the session", async () => {
  const sandbox = sink();
  const run = await startTerminalSession({ sandbox, command: "cat huge.log" });

  sandbox.session?.emit("stdout", "x".repeat(TERMINAL_MAX_OUTPUT_BYTES + 4_096));

  const records = await collect(run.records);
  const stdoutBytes = records
    .filter(
      (record): record is Extract<TerminalRecord, { type: "stdout" }> =>
        record.type === "stdout",
    )
    .reduce((total, record) => total + Buffer.byteLength(record.data), 0);
  assert.ok(stdoutBytes <= TERMINAL_MAX_OUTPUT_BYTES);
  assert.equal(records.at(-1)?.type, "truncated");
  assert.deepEqual(sandbox.session?.signals, ["KILL"]);
});

test("times out a session and terminates it", async () => {
  const sandbox = sink();
  const run = await startTerminalSession({
    sandbox,
    command: "sleep 100",
    timeoutMs: 1,
  });

  const records = await collect(run.records);
  assert.deepEqual(records.at(-1), {
    type: "error",
    code: "timeout",
    message: "Session timed out after 1000ms.",
  });
  assert.equal(sandbox.session?.terminated, true);
});

test("rejects terminals on backends without live sessions", async () => {
  await assert.rejects(
    startTerminalSession({
      sandbox: {} as never,
      command: "ls",
    }),
    /does not support live terminal sessions/,
  );
});

test("terminal authorization helper only allows the run owner", () => {
  assert.equal(canAccessWorkspace("user-1", "user-1"), true);
  assert.equal(canAccessWorkspace("user-1", "user-2"), false);
  assert.equal(canAccessWorkspace("", ""), false);
});

test("terminal request validation and timeout clamping", () => {
  assert.equal(clampTerminalTimeout(undefined), 15 * 60_000);
  assert.equal(clampTerminalTimeout(10), 1_000);
  assert.equal(clampTerminalTimeout(99_999_999), 60 * 60_000);

  const parsed = parseTerminalRequest({ command: "ls -la", cwd: "src" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.command, "ls -la");
    assert.equal(parsed.value.cwd, "src");
    assert.equal(parsed.value.tty, true);
  }
  const raw = parseTerminalRequest({
    command: "vim",
    tty: false,
    rows: 24,
    cols: 80,
  });
  assert.equal(raw.ok, true);
  if (raw.ok) {
    assert.equal(raw.value.tty, false);
    assert.equal(raw.value.rows, 24);
  }
  assert.equal(parseTerminalRequest({ command: "" }).ok, false);
  assert.equal(parseTerminalRequest({ command: "ls", cwd: "../etc" }).ok, false);
  assert.equal(parseTerminalRequest({ command: "ls", timeoutMs: "soon" }).ok, false);
  assert.equal(parseTerminalRequest({ command: "ls", tty: "yes" }).ok, false);
  assert.equal(parseTerminalRequest({ command: "ls", rows: 0 }).ok, false);
});

test("terminal input validation", () => {
  assert.deepEqual(parseTerminalInput({ type: "stdin", data: "echo hi\n" }), {
    ok: true,
    value: { type: "stdin", data: "echo hi\n" },
  });
  assert.deepEqual(parseTerminalInput({ type: "resize", rows: 40, cols: 120 }), {
    ok: true,
    value: { type: "resize", rows: 40, cols: 120 },
  });
  const signal = parseTerminalInput({ type: "signal", signal: "int" });
  assert.equal(signal.ok, true);
  if (signal.ok) assert.deepEqual(signal.value, { type: "signal", signal: "INT" });
  assert.equal(parseTerminalInput({ type: "signal", signal: "HALT" }).ok, false);
  assert.equal(parseTerminalInput({ type: "stdin", data: 42 }).ok, false);
  assert.equal(parseTerminalInput({ type: "resize", rows: 0, cols: 1 }).ok, false);
});

test("terminal slot is exclusive per user and releases", () => {
  resetTerminalRegistryForTest();
  const release = acquireTerminalSlot("user-1");
  assert.ok(release);
  assert.equal(acquireTerminalSlot("user-1"), undefined);
  assert.ok(acquireTerminalSlot("user-2"));
  release();
  assert.ok(acquireTerminalSlot("user-1"));
  resetTerminalRegistryForTest();
});
