import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask } from "@buildx/agent";
import type { RunStatus } from "@buildx/shared";
import { envStatus, isTerminalStatus } from "@buildx/shared";
import {
  appendEvent,
  finishRun,
  markRunning,
  persistStats,
  type StoredRun,
} from "./store";
import { captureWorkspaceSnapshot } from "./workspace-fs";
import { createSandbox, sandboxSettings } from "./sandbox";
import { sourceForRun } from "./workspace-source";

/** Seed the workspace so `list_dir` / `read_file` have something real to read. */
async function seedWorkspace(run: StoredRun): Promise<void> {
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
 */
async function closeRun(
  run: StoredRun,
  status: RunStatus,
  message?: string,
): Promise<void> {
  const last = [...run.events].reverse().find((event) => event.type === "status");
  if (!last || !isTerminalStatus(last.data.status)) {
    await appendEvent(run, {
      type: "status",
      data: { status, message },
      ts: Date.now(),
    });
  }
  await finishRun(run, status, status === "failed" ? message : undefined);
}

/**
 * Execute one queued run: seed + start the sandbox, drive `runTask`, append
 * every step to the event store, and tear the sandbox down. Runs detached from
 * the request that created it (arcetecture.md §5.2).
 */
export async function startRun(run: StoredRun): Promise<void> {
  // Stopped before we got scheduled — the stop route already closed the run.
  if (isTerminalStatus(run.status) || run.controller.signal.aborted) return;

  const config = envStatus();
  if (!config.hasApiKey) {
    const message =
      "OPENAI_API_KEY is not set. Copy .env.example to .env.local, add your key, and restart the dev server.";
    await appendEvent(run, { type: "error", data: { message }, ts: Date.now() });
    await closeRun(run, "failed", message);
    return;
  }

  const sandbox = createSandbox({
    workspaceDir: run.workspaceDir,
    userId: run.userId,
    workspaceName: run.workspaceName,
  });
  try {
    await sandbox.start();
    await seedWorkspace(run);
    await markRunning(run);

    // Local mode snapshots immediately; box mode snapshots lazily once a
    // workspace has actually been restored.
    if (sandboxSettings().kind === "local") {
      run.baseline = await captureWorkspaceSnapshot(sourceForRun(run));
    }

    const result = await runTask({
      task: run.task,
      sandbox,
      model: run.model,
      maxSteps: run.maxSteps,
      abortSignal: run.controller.signal,
      onEvent: (event) => {
        appendEvent(run, event);
      },
    });

    run.stats = { steps: result.steps, usage: result.usage };
    await persistStats(run);
    await closeRun(
      run,
      result.status,
      result.status === "failed" ? "the agent run failed" : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/monthly CPU budget exhausted/i.test(message)) {
      run.workspace.message = "Your work is saved.";
    }
    await appendEvent(run, {
      type: "error",
      data: { message },
      ts: Date.now(),
    });
    await closeRun(
      run,
      run.controller.signal.aborted ? "cancelled" : "failed",
      message,
    );
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
