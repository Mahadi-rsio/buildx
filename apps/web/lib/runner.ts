import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask } from "@buildx/agent";
import type { Sandbox } from "@buildx/sandbox";
import {
  envStatus,
  isTerminalStatus,
  providerEndpoint,
  resolveModelProvider,
} from "@buildx/shared";
import { getDb, isRunCancelled, readRunControl } from "@buildx/db";
import {
  appendEvent,
  finishRun,
  flushAppends,
  persistStats,
  type StoredRun,
  type TerminalRunStatus,
} from "./store";
import { captureWorkspaceSnapshot } from "./workspace-fs";
import { cancelRemoteBoxExecution, createSandbox, sandboxSettings } from "./sandbox";
import { sourceForRun } from "./workspace-source";

function guardSandbox(sandbox: Sandbox, run: StoredRun): Sandbox {
  const checkOwnership = async (): Promise<void> => {
    if (run.runtime.lostOwnership) {
      throw new Error(`Worker lost ownership of run ${run.id}; workspace mutation rejected`);
    }
    if (run.runtime.controller.signal.aborted) {
      throw new Error(`Run ${run.id} has been aborted; workspace mutation rejected`);
    }
    if (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now()) {
      run.runtime.lostOwnership = true;
      run.runtime.controller.abort();
      throw new Error(`Worker lease expired for run ${run.id}; workspace mutation rejected`);
    }
    // Check Neon DB for durable cross-isolate cancellation
    if (run.leaseId) {
      const ctrl = await readRunControl(getDb(), {
        runId: run.id,
        leaseId: run.leaseId,
        fencingToken: run.fencingToken,
      }).catch(() => null);
      if (ctrl) {
        if (!ctrl.ownsLease) {
          run.runtime.lostOwnership = true;
          run.runtime.controller.abort();
          throw new Error(`Worker lost lease of run ${run.id}`);
        }
        if (ctrl.cancelled) {
          run.runtime.controller.abort();
          throw new Error(`Run ${run.id} has been cancelled by user`);
        }
      }
    }
  };

  return {
    ...sandbox,
    get id() {
      return sandbox.id;
    },
    async start() {
      await checkOwnership();
      return sandbox.start();
    },
    async suspend() {
      return sandbox.suspend();
    },
    async destroy() {
      return sandbox.destroy();
    },
    async writeFile(path: string, content: string) {
      await checkOwnership();
      await sandbox.writeFile(path, content);
      await checkOwnership();
    },
    async *exec(cmd: string, opts) {
      await checkOwnership();
      for await (const chunk of sandbox.exec(cmd, opts)) {
        await checkOwnership();
        yield chunk;
      }
      await checkOwnership();
    },
    async readFile(path: string, range) {
      await checkOwnership();
      return sandbox.readFile(path, range);
    },
    async startBackground(cmd: string) {
      await checkOwnership();
      const res = await sandbox.startBackground(cmd);
      await checkOwnership();
      return res;
    },
    async checkpoint(label: string) {
      await checkOwnership();
      const res = await sandbox.checkpoint(label);
      await checkOwnership();
      return res;
    },
    async restore(id: string) {
      await checkOwnership();
      await sandbox.restore(id);
      await checkOwnership();
    },
    async previewUrl(port: number) {
      return sandbox.previewUrl(port);
    },
  };
}

/** Seed the workspace so `list_dir` / `read_file` have something real to read. */
async function seedWorkspace(run: StoredRun): Promise<void> {
  if (
    run.runtime.lostOwnership ||
    run.runtime.controller.signal.aborted ||
    (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
  ) {
    run.runtime.lostOwnership = true;
    throw new Error(`Cannot seed workspace: run ${run.id} lost ownership or expired`);
  }
  const readme = [
    "# buildx workspace",
    "",
    `Run: \`${run.id}\``,
    `Model: \`${run.model}\` (max ${run.maxSteps} steps)`,
    "",
    "## Task",
    "",
    run.task,
    "",
    "Every file the agent creates or edits lands in this directory.",
    "",
  ].join("\n");
  // Local mode only: box workspaces are never seeded eagerly, so a plain chat
  // message doesn't spin a box up. The box is created lazily on the agent's
  // first sandbox tool call instead.
  if (sandboxSettings().kind === "local") {
    await mkdir(run.workspaceDir, { recursive: true });
    await writeFile(join(run.workspaceDir, "README.md"), readme, "utf8");
  }
}

/**
 * Ensure the run ends with exactly one terminal `status` event so SSE clients
 * always see the stream close, even when the loop dies before emitting its own.
 * Flushes the append chain first so Postgres observes every event in order
 * before the lease-guarded terminal transition runs.
 */
async function closeRun(
  run: StoredRun,
  status: TerminalRunStatus,
  message?: string,
): Promise<void> {
  // A fenced process must not write onto a run the reclaiming worker owns.
  if (
    run.runtime.lostOwnership ||
    (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
  ) {
    run.runtime.lostOwnership = true;
    return;
  }
  // If the run was cancelled in Neon DB, ensure the terminal status reflects it
  if (status !== "cancelled" && run.id) {
    const ctrl = await isRunCancelled(getDb(), run.id).catch(() => null);
    if (ctrl?.cancelled) {
      status = "cancelled";
      message = ctrl.reason ?? "stopped by the user";
    }
  }
  const last = [...run.events].reverse().find((event) => event.type === "status");
  if (!last || !isTerminalStatus(last.data.status)) {
    await appendEvent(run, {
      type: "status",
      data: { status, message },
      ts: Date.now(),
    });
  }
  await flushAppends(run.id);
  await finishRun(run, status, status === "failed" ? message : undefined);
}

/**
 * Execute one claimed run: seed + start the sandbox, drive `runTask`, append
 * every step to the event store, and tear the sandbox down. Called by the job
 * worker once it owns the run's lease (the claim sets `status: running`); this
 * routine never touches the queue itself.
 */
export async function startRun(run: StoredRun): Promise<void> {
  // Stopped (or fenced) before we got scheduled — the worker handles the
  // terminal finalize for this case; returning here leaves the lease for the
  // worker's post-loop fallback.
  if (
    isTerminalStatus(run.status) ||
    run.runtime.controller.signal.aborted ||
    run.runtime.lostOwnership ||
    (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
  ) {
    return;
  }

  const config = envStatus();
  const provider = resolveModelProvider(run.model, config);
  const endpoint = providerEndpoint(provider);
  if (!endpoint.apiKey) {
    const message =
      provider === "vercel"
        ? "VERCEL_AI_GATEWAY_API_KEY is not set for the selected model. Add it to .env.local and restart the dev server."
        : "OPENAI_API_KEY is not set. Copy .env.example to .env.local, add your key, and restart the dev server.";
    await appendEvent(run, { type: "error", data: { message }, ts: Date.now() });
    await closeRun(run, "failed", message);
    return;
  }

  const rawSandbox = createSandbox({
    workspaceDir: run.workspaceDir,
    userId: run.userId,
    workspaceName: run.workspaceName,
  });
  const sandbox = guardSandbox(rawSandbox, run);
  try {
    await sandbox.start();
    await seedWorkspace(run);

    // Local mode snapshots immediately; box mode snapshots lazily once a
    // workspace has actually been restored.
    if (sandboxSettings().kind === "local") {
      run.runtime.baseline = await captureWorkspaceSnapshot(sourceForRun(run));
    }

    const result = await runTask({
      task: run.task,
      history: run.history,
      sandbox,
      model: run.model,
      apiKey: endpoint.apiKey,
      baseURL: endpoint.baseURL,
      maxSteps: run.maxSteps,
      abortSignal: run.runtime.controller.signal,
      onEvent: (event) => {
        // Live usage event: keep the in-memory stats current and persist them so
        // a refresh mid-run still shows real tokens/steps.
        if (event.type === "usage") {
          run.stats = {
            steps: event.data.steps,
            usage: {
              inputTokens: event.data.inputTokens,
              outputTokens: event.data.outputTokens,
              totalTokens: event.data.totalTokens,
            },
          };
          void persistStats(run).catch((error) => {
            console.error(
              `[buildx-worker] stats persist failed (run ${run.id})`,
              error,
            );
          });
        }
        // Fire-and-forget: the append chain serializes per-run writes. Errors
        // are surfaced (a failed append must not silently drop the event
        // stream) without letting a transient failure abort execution.
        void appendEvent(run, event).catch((error) => {
          console.error(
            `[buildx-worker] event append failed (run ${run.id})`,
            error,
          );
        });
      },
    });

    if (
      run.runtime.lostOwnership ||
      (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
    ) {
      run.runtime.lostOwnership = true;
      return;
    }
    run.stats = { steps: result.steps, usage: result.usage };
    await persistStats(run);
    const finalStatus =
      run.runtime.controller.signal.aborted || result.status === "cancelled"
        ? "cancelled"
        : (result.status as TerminalRunStatus);
    await closeRun(
      run,
      finalStatus,
      finalStatus === "failed"
        ? result.error ?? "the agent run failed"
        : finalStatus === "cancelled"
          ? "stopped by the user"
          : undefined,
    );
  } catch (error) {
    // A fenced run is owned by the reclaiming worker now — nothing to write.
    if (
      run.runtime.lostOwnership ||
      (run.leaseExpiresAt && run.leaseExpiresAt <= Date.now())
    ) {
      run.runtime.lostOwnership = true;
      console.warn(`[buildx-worker] fenced during run ${run.id}; skipping writes`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const isCancelled =
      run.runtime.controller.signal.aborted ||
      /cancelled|aborted/i.test(message);

    if (isCancelled) {
      void cancelRemoteBoxExecution(run.userId).catch(() => undefined);
    } else {
      if (/monthly CPU budget exhausted/i.test(message)) {
        run.runtime.workspace.message = "Your work is saved.";
      }
      await appendEvent(run, {
        type: "error",
        data: { message },
        ts: Date.now(),
      });
    }

    await closeRun(
      run,
      isCancelled ? "cancelled" : "failed",
      isCancelled ? "stopped by the user" : message,
    );
  } finally {
    await rawSandbox.destroy().catch(() => undefined);
  }
}