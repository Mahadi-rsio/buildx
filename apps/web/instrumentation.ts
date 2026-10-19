/**
 * In-process run worker startup.
 *
 * The worker claims queued runs from PostgreSQL and executes them against
 * Upstash Box. It runs in the same Node.js process as the web server and
 * persists all state to the database, so the HTTP request that created the
 * run returns immediately. The worker loop runs on every Node.js server
 * instance; lease-based claiming and fencing tokens prevent double execution.
 */
let workerPromise: Promise<void> | undefined;

const RESTART_DELAY_MS = 5_000;

function startWorker(): void {
  if (workerPromise) return;

  workerPromise = (async () => {
    while (true) {
      // Imported lazily so `instrumentation.ts` stays side-effect free during
      // static analysis and the Next build; the worker only boots at runtime.
      const worker = await import("./lib/job-worker");
      if (worker.isWorkerStopped()) break;
      try {
        await worker.runWorker();
      } catch (error) {
        console.error("[buildx-worker] crashed; restarting", error);
      }
      if (worker.isWorkerStopped()) break;
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
    }
  })();

  void workerPromise.finally(() => {
    workerPromise = undefined;
  });
}

const instrumentation = {
  register() {
    // Run the worker in Node.js (dev and production). The worker claims runs
    // from the database and executes them with proper lease management.
    if (
      process.env.NEXT_RUNTIME === "nodejs" &&
      !process.env.BUILDX_DISABLE_LOCAL_WORKER
    ) {
      startWorker();
    }
  },
};

export default instrumentation;