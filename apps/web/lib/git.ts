import {
  GitError,
  WorkspaceGit,
  type GitErrorCode,
  type Sandbox,
} from "@buildx/sandbox";

export { GitError, WorkspaceGit };

/** HTTP status for each typed git failure. */
const STATUS_BY_CODE: Record<GitErrorCode, number> = {
  invalid_url: 400,
  invalid_branch: 400,
  invalid_path: 400,
  not_a_repository: 404,
  path_exists: 409,
  repository_exists: 409,
  branch_exists: 409,
  branch_not_found: 404,
  dirty_working_tree: 409,
  clone_failed: 500,
  checkout_failed: 409,
  git_missing: 500,
  timeout: 504,
  command_failed: 500,
};

/** Build the git service for an already-resolved workspace box. */
export function workspaceGit(sandbox: Sandbox): WorkspaceGit {
  return new WorkspaceGit(sandbox);
}

/** Map a typed git failure to its JSON response (500 for unknown errors). */
export function gitErrorResponse(error: unknown): Response {
  if (error instanceof GitError) {
    return Response.json(
      {
        error: error.code,
        message: error.message,
        ...(error.changedFiles ? { changedFiles: error.changedFiles } : {}),
      },
      { status: STATUS_BY_CODE[error.code] ?? 500 },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: "git_failed", message }, { status: 500 });
}

/** 404 used when no persisted local PR draft exists. */
export function draftNotFound(): Response {
  return Response.json(
    {
      error: "draft_not_found",
      message: "No local pull-request draft exists for that repository and head branch.",
    },
    { status: 404 },
  );
}
