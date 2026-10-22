import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, RunRow } from "@buildx/db";
import type { RunEvent } from "@buildx/shared";
import {
  processNextRun,
  resetWorkerForTest,
  runWorker,
  type WorkerDeps,
} from "./job-worker";
import type { StoredRun } from "./store";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: "run-1",
    userId: "user-1",
    workspaceName: "workspace",
    task: "do a thing",
    status: "running",
    model: "gpt-4o-mini",
    maxSteps: 5,
    contextWindowTokens: 100_000,
    createdAt: 0,
    updatedAt: 0,
    events: [],
    runtime: {
      subscribers: new Set(),
      controller: new AbortController(),
      lostOwnership: false,
      workspace: { status: "idle" },
    },
    ...overrides,
  };
}

function fakeClaim(overrides: Partial<RunRow> = {}): RunRow {
  const now = new Date();
  return {
    id: "run-1",
    userId: "user-1",
    taskId: null,
    model: "gpt-4o-mini",
    status: "running",
    task: "do a thing",
    workspaceName: "workspace",
    maxSteps: 5,
    contextWindowTokens: 100_000,
    stepCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: now,
    endedAt: null,
    error: null,
    leaseId: "lease-x",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    cancelledAt: null,
    cancelReason: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as RunRow;
}

interface TestDeps {
  calls: string[];
  run: StoredRun;
  claimCount?: number;
  overrides?: Partial<
    Record<
      keyof WorkerDeps,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >
  >;
}

function makeDeps(opts: TestDeps): WorkerDeps {
  const { calls, run } = opts;
  let claims = 0;
  const defaultFns: WorkerDeps = {
    db: {
      execute: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as Db,
    config: {
      heartbeatMs: 5,
      watchdogMs: 5,
      loopIdleMs: 5,
      loopFastMs: 5,
      startupBackoffMs: 2,
      maxBackoffMs: 20,
      leaseTtlMs: 60_000,
      lockTtlMs: 60_000,
    },
    recoverTimedOutRuns: async () => {
      calls.push("recover");
      return 0;
    },
    claimNextQueuedRun: async () => {
      if (opts.claimCount !== undefined && claims >= opts.claimCount) return null;
      claims += 1;
      calls.push("claim");
      return fakeClaim();
    },
    readRunControl: async () => ({ cancelled: false, reason: null, ownsLease: true }),
    heartbeatRun: async () => {
      calls.push("heartbeat");
      return true;
    },
    acquireWorkspaceLock: async () => {
      calls.push("lock");
      return true;
    },
    renewWorkspaceLock: async () => true,
    releaseRunLease: async () => {
      calls.push("release-lease");
      return true;
    },
    releaseWorkspaceLock: async () => {
      calls.push("release-lock");
      return true;
    },
    requeueRun: async () => {
      calls.push("requeue");
      return true;
    },
    bindClaim: async (row) => {
      void row;
      calls.push("bind");
      return run;
    },
    appendEvent: async (_r, input) => {
      calls.push(`append:${(input.data as { status?: string }).status ?? "event"}`);
      return {
        ...input,
        id: calls.length,
        runId: run.id,
        ts: Date.now(),
      } as unknown as RunEvent;
    },
    flushAppends: async () => {
      calls.push("flush");
    },
    finishRun: async (_r, status) => {
      calls.push(`finish:${status}`);
      return true;
    },
    startRun: async () => {
      calls.push("start");
    },
    workspaceIdentityFor: () => `run:${run.id}`,
  };

  for (const [key, value] of Object.entries(opts.overrides ?? {})) {
    if (key === "config" && typeof value === "object" && value !== null) {
      defaultFns.config = { ...defaultFns.config, ...value };
    } else {
      (defaultFns as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return defaultFns;
}

function startUntilAborted(run: StoredRun): Promise<void> {
  return new Promise((resolve) => {
    if (run.runtime.controller.signal.aborted) return resolve();
    run.runtime.controller.signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });
}

/** Start the run as the real runner would: mark it executing, then block until
 *  the runtime controller aborts (fence or cancellation). */
function startAndRun(deps: { calls: string[] }, run: StoredRun): Promise<void> {
  deps.calls.push("start");
  return startUntilAborted(run);
}

test("startup DB outage retries with backoff, then recovers and claims", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  let healthy = false;
  let pingAttempts = 0;

  const deps = makeDeps({ calls, run, overrides: {} });
  deps.db = {
    execute: async () => {
      pingAttempts += 1;
      if (!healthy) throw new Error("db down");
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;

  const worker = runWorker({ signal: control.signal, deps });
  await sleep(25);
  assert.ok(pingAttempts > 1, "startup failures are retried, not fatal");
  assert.ok(!calls.includes("claim"), "no claiming happens while the db is down");

  healthy = true;
  for (let i = 0; i < 100 && !calls.includes("claim"); i += 1) {
    await sleep(5);
  }
  assert.ok(calls.includes("claim"), "worker claims once the database is reachable");

  control.abort();
  await worker;
});

test("heartbeat lease loss fences the run, aborts the loop, and skips finalize", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      heartbeatRun: async () => {
        calls.push("heartbeat:lost");
        return false;
      },
      startRun: (r: StoredRun) => startAndRun({ calls }, r),
    },
  });

  const worker = runWorker({ signal: control.signal, deps });
  for (let i = 0; i < 200 && !run.runtime.lostOwnership; i += 1) {
    await sleep(5);
  }

  assert.equal(run.runtime.lostOwnership, true, "loss of lease is fenced");
  assert.equal(run.runtime.controller.signal.aborted, true, "the agent loop is stopped");
  assert.ok(calls.includes("start"), "the run was executing when it was fenced");
  assert.ok(
    !calls.some((c) => c.startsWith("finish")),
    "a fenced worker never finalizes a run it no longer owns",
  );
  // The loop keeps polling for other runs; shutdown still resolves cleanly.
  control.abort();
  await worker;
  assert.ok(calls.includes("release-lease"), "session cleanup still runs");
});

test("a persisted cancellation observed mid-run aborts and finalizes cancelled", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      // The cancel flag appears *after* the run starts: this exercises the
      // watchdog aborting a live agent mid-run, not the pre-start cancel check.
      readRunControl: async () => {
        const started = calls.includes("start");
        return {
          cancelled: started,
          reason: started ? "stopped by the user" : null,
          ownsLease: true,
        };
      },
      startRun: (r: StoredRun) => startAndRun({ calls }, r),
    },
  });

  const worker = runWorker({ signal: control.signal, deps });
  for (let i = 0; i < 200 && !calls.includes("finish:cancelled"); i += 1) {
    await sleep(5);
  }

  assert.equal(run.runtime.controller.signal.aborted, true, "cancellation aborts the loop");
  assert.ok(calls.includes("append:cancelled"), "terminal status event is written");
  assert.ok(calls.includes("finish:cancelled"), "run is finalized as cancelled");

  control.abort();
  await worker;
});

test("watchdog lease takeover (no heartbeat yet) lets another owner finalize", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      readRunControl: async () => ({ cancelled: false, reason: null, ownsLease: false }),
      startRun: async (r: StoredRun) => startUntilAborted(r),
      heartbeatRun: async () => {
        calls.push("heartbeat");
        return true;
      },
    },
  });

  const worker = runWorker({ signal: control.signal, deps });
  for (let i = 0; i < 200 && !run.runtime.lostOwnership; i += 1) {
    await sleep(5);
  }
  assert.equal(run.runtime.lostOwnership, true, "takeover detected by the watchdog");
  assert.ok(
    !calls.some((c) => c.startsWith("finish")),
    "stale owner must not finalize the run",
  );

  control.abort();
  await worker;
});

test("a mid-loop error backs off and retries without killing the worker", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  let failures = 1;
  const deps = makeDeps({
    calls,
    run,
    overrides: {
      claimNextQueuedRun: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("transient infrastructure blip");
        }
        calls.push("claim");
        return null;
      },
    },
  });

  const worker = runWorker({ signal: control.signal, deps });
  for (let i = 0; i < 200 && !calls.includes("claim"); i += 1) {
    await sleep(5);
  }
  assert.ok(calls.includes("claim"), "worker retried after the transient error");
  assert.equal(failures, 0);

  control.abort();
  await worker;
});

test("processNextRun returns false when the workspace lock is busy", async () => {
  resetWorkerForTest();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    overrides: {
      acquireWorkspaceLock: async () => false,
    },
  });
  assert.equal(await processNextRun(deps), false, "idle loop continues");
  assert.ok(calls.includes("release-lease"), "lease handed back when the lock is held");
  assert.ok(!calls.includes("start"), "nothing starts while the workspace is locked");
});

test("stale worker release can't drop a reclaimed lease", async () => {
  resetWorkerForTest();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      releaseRunLease: async () => {
        calls.push("release-lease:denied");
        return false;
      },
      releaseWorkspaceLock: async () => {
        calls.push("release-lock:denied");
        return false;
      },
      heartbeatRun: async () => false,
      startRun: (r: StoredRun) => startAndRun({ calls }, r),
    },
  });
  const control = new AbortController();
  const worker = runWorker({ signal: control.signal, deps });
  for (let i = 0; i < 200 && !run.runtime.lostOwnership; i += 1) {
    await sleep(5);
  }
  assert.equal(run.runtime.lostOwnership, true);
  control.abort();
  await worker;
});

test("workspace lock contention requeues run back to queued state", async () => {
  resetWorkerForTest();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    overrides: {
      acquireWorkspaceLock: async () => false,
    },
  });
  const processed = await processNextRun(deps);
  assert.equal(processed, false);
  assert.ok(calls.includes("requeue"), "requeueRun was called to return run to queued state");
  assert.ok(!calls.includes("start"), "run never starts while workspace is locked");
});

test("prolonged database outage exceeding gracePeriodMs fences worker and aborts task", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      config: {
        heartbeatMs: 5,
        watchdogMs: 5,
        gracePeriodMs: 20,
      },
      heartbeatRun: async () => {
        throw new Error("DB connection lost during heartbeat");
      },
      readRunControl: async () => {
        if (!calls.includes("start")) {
          return { cancelled: false, reason: null, ownsLease: true };
        }
        throw new Error("DB connection lost during watchdog");
      },
      startRun: (r: StoredRun) => startAndRun({ calls }, r),
    },
  });

  const worker = runWorker({ signal: control.signal, deps });
  for (let i = 0; i < 200 && !run.runtime.lostOwnership; i += 1) {
    await sleep(5);
  }

  assert.equal(run.runtime.lostOwnership, true, "worker is fenced when DB outage exceeds grace period");
  assert.equal(run.runtime.controller.signal.aborted, true, "task is aborted on prolonged outage");
  assert.ok(!calls.some((c) => c.startsWith("finish")), "fenced worker never finalizes after outage");

  control.abort();
  await worker;
});

test("transient DB error within gracePeriodMs does not fence worker", async () => {
  resetWorkerForTest();
  const control = new AbortController();
  const calls: string[] = [];
  const run = fakeRun();
  let heartbeatCount = 0;

  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      config: {
        heartbeatMs: 5,
        watchdogMs: 5,
        gracePeriodMs: 200,
      },
      heartbeatRun: async () => {
        heartbeatCount += 1;
        if (heartbeatCount === 1) {
          throw new Error("transient DB blip");
        }
        return true;
      },
      readRunControl: async () => ({ cancelled: false, reason: null, ownsLease: true }),
      startRun: async () => {
        await sleep(25);
      },
    },
  });

  const worker = runWorker({ signal: control.signal, deps });
  await sleep(35);

  assert.equal(run.runtime.lostOwnership, false, "transient error within grace period does not fence");
  control.abort();
  await worker;
});

test("startRun pausing on waiting_input returns without finalizing", async () => {
  resetWorkerForTest();
  const calls: string[] = [];
  const run = fakeRun();

  const deps = makeDeps({
    calls,
    run,
    claimCount: 1,
    overrides: {
      startRun: async (current: StoredRun) => {
        calls.push("start");
        current.status = "waiting_input";
      },
    },
  });

  const processed = await processNextRun(deps);
  assert.equal(processed, true, "waiting_input is a processed, not idle, loop iteration");
  assert.ok(calls.includes("start"), "startRun was invoked");
  assert.ok(
    !calls.some((c) => c.startsWith("finish")),
    "a paused run is never finalized by the worker",
  );
  assert.ok(
    !calls.includes("requeue"),
    "a paused run keeps its paused status; only the answer endpoint requeues it",
  );
});