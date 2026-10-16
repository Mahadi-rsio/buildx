import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask } from "@buildx/agent";
import { LocalSandbox } from "@buildx/sandbox";
import type { RunStatus } from "@buildx/shared";
import { envStatus, isTerminalStatus } from "@buildx/shared";
import { appendEvent, finishRun, type StoredRun } from "./store";
import { captureWorkspaceSnapshot } from "./workspace-fs";

/** Seed the workspace so `list_dir` / `read_file` have something real to read. */
async function seedWorkspace(run: StoredRun): Promise<void> {
  await mkdir(run.workspaceDir, { recursive: true });
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
  await writeFile(join(run.workspaceDir, "README.md"), readme, "utf8");
}

/**
 * Ensure the run ends with exactly one terminal `status` event so SSE clients
 * always see the stream close, even when the loop dies before emitting its own.
 */
function closeRun(run: StoredRun, status: RunStatus, message?: string): void {
  const last = [...run.events].reverse().find((event) => event.type === "status");
  if (!last || !isTerminalStatus(last.data.status)) {
    appendEvent(run, { type: "status", data: { status, message }, ts: Date.now() });
  }
  finishRun(run, status, status === "failed" ? message : undefined);
}

/**
 * Execute one queued run: seed + start the sandbox, drive `runTask`, append
 * every step to the in-memory event store, and tear the sandbox down. Runs
 * detached from the request that created it (arcetecture.md §5.2).
 */
export async function startRun(run: StoredRun): Promise<void> {
  // Stopped before we got scheduled — the stop route already closed the run.
  if (isTerminalStatus(run.status) || run.controller.signal.aborted) return;

  const config = envStatus();
  if (!config.hasApiKey) {
    const message =
      "OPENAI_API_KEY is not set. Copy .env.example to .env.local, add your key, and restart the dev server.";
    appendEvent(run, { type: "error", data: { message }, ts: Date.now() });
    closeRun(run, "failed", message);
    return;
  }

  await seedWorkspace(run);

  const sandbox = new LocalSandbox({ rootDir: run.workspaceDir });
  try {
    await seedWorkspace(run);
    await sandbox.start();
    run.status = "running";
    run.updatedAt = Date.now();

    // Snapshot the seeded workspace so the Changes tab can diff against it.
    run.baseline = await captureWorkspaceSnapshot(run.workspaceDir);

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
    closeRun(
      run,
      result.status,
      result.status === "failed" ? "the agent run failed" : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEvent(run, { type: "error", data: { message }, ts: Date.now() });
    closeRun(
      run,
      run.controller.signal.aborted ? "cancelled" : "failed",
      message,
    );
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
