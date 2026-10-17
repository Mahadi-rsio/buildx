/** Lazy worker startup so a dev restart / hot reload can restart cleanly. */
let workerStarted = false;

function startWorker(): void {
  if (workerStarted) return;

  // Imported lazily so `instrumentation.ts` stays side-effect free during
  // static analysis and the Next build; the worker only boots on a real run.
  void import("./lib/job-worker")
    .then(({ runWorker }) => {
      workerStarted = true;
      // Fire-and-forget on purpose: the worker must never block request
      // handling or the build. It recovers/claims/executes detached (§9).
      void runWorker().catch(() => {
        workerStarted = false;
      });
    })
    .catch(() => {
      workerStarted = false;
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