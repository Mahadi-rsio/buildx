/**
 * Node.js-only startup for BuildX's in-process queue worker.
 *
 * Keep this file separate from instrumentation.ts: Next.js bundles the
 * instrumentation entrypoint for Edge as well, and the worker transitively
 * imports Node-only APIs (crypto, fs, child_process, DNS and zlib).
 */
let workerPromise: Promise<void> | undefined;

const RESTART_DELAY_MS = 5_000;

function startWorker(): void {
  if (workerPromise) return;

  workerPromise = (async () => {
    while (true) {
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

export function register(): void {
  startWorker();
}
