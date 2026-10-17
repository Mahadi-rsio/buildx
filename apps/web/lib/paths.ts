import { join, resolve } from "node:path";

/**
 * Root under which every run gets its own scratch workspace. Defaults to
 * `<cwd>/.workspaces` (gitignored; `cwd` is `apps/web` under Next) and can be
 * redirected with `BUILDX_WORKSPACE_DIR` for CI.
 */
export function workspaceRoot(): string {
  return resolve(
    /* turbopackIgnore: true */
    process.env.BUILDX_WORKSPACE_DIR?.trim() || join(process.cwd(), ".workspaces"),
  );
}

/** Absolute workspace directory for a run id. */
export function workspaceDirFor(runId: string): string {
  return join(workspaceRoot(), runId);
}
