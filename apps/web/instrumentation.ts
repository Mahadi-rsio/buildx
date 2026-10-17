/**
 * Lazy, restart-safe worker startup. A single loop per process (`workerPromise`
 * is the guard); if it exits (or crashes) it is scheduled to start again, and a
 * dev hot-reload can restart cleanly because the flag is reset on exit.
 */
let workerPromise: Promise<void> | undefined;

const RESTART_DELAY_MS = 5_000;

function startWorker(): void {
  if (workerPromise) return;

  workerPromise = (async () => {
    while (true) {
      // Imported lazily so `instrumentation.ts` stays side-effect free during
      // static analysis and the Next build; the worker only boots on a real
      // run.
      const worker = await import("./lib/job-worker");
      if (worker.isWorkerStopped()) break;
      try {
        // Fire-and-forget on purpose: the worker must never block request
        // handling or the build. It recovers/claims/executes detached (§9) and
        // retries transient database outages internally.
        await worker.runWorker();
      } catch (error) {
        console.error("[buildx-worker] crashed; restarting", error);
      }
      if (worker.isWorkerStopped()) break;
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
    }
  })();

  // Reset on exit so a dev restart / hot reload can start a fresh loop.
  void workerPromise.finally(() => {
    workerPromise = undefined;
  });
}

const instrumentation = {
  register() {
    // Node server runtime only — never during static analysis or the Next
    // build. Runs the durable job worker (claims leases, executes runs,
    // recovers stalled work).
    if (process.env.NEXT_RUNTIME === "nodejs") {
      startWorker();
    }
  },
};

export default instrumentation;