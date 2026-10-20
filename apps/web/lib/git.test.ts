import assert from "node:assert/strict";
import { test } from "node:test";
import { GitError } from "@buildx/sandbox";
import { draftNotFound, gitErrorResponse } from "./git";

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("gitErrorResponse maps validation, missing, conflict, and timeout codes", async () => {
  const cases: Array<[GitError, number]> = [
    [new GitError("invalid_url", "bad url"), 400],
    [new GitError("invalid_branch", "bad branch"), 400],
    [new GitError("not_a_repository", "missing repo"), 404],
    [new GitError("branch_not_found", "missing branch"), 404],
    [new GitError("repository_exists", "exists"), 409],
    [new GitError("path_exists", "exists"), 409],
    [new GitError("timeout", "timed out"), 504],
    [new GitError("git_missing", "no git"), 500],
  ];

  for (const [error, status] of cases) {
    const response = gitErrorResponse(error);
    assert.equal(response.status, status, error.code);
    const data = await body(response);
    assert.equal(data.error, error.code);
    assert.equal(data.message, error.message);
  }
});

test("gitErrorResponse includes the changed files for a dirty working tree", async () => {
  const response = gitErrorResponse(
    new GitError("dirty_working_tree", "dirty", {
      changedFiles: ["README.md", "src/a.ts"],
    }),
  );
  assert.equal(response.status, 409);
  const data = await body(response);
  assert.equal(data.error, "dirty_working_tree");
  assert.deepEqual(data.changedFiles, ["README.md", "src/a.ts"]);
});

test("gitErrorResponse falls back to a 500 for unknown errors", async () => {
  const response = gitErrorResponse(new Error("boom"));
  assert.equal(response.status, 500);
  const data = await body(response);
  assert.equal(data.error, "git_failed");
  assert.equal(data.message, "boom");
});

test("draftNotFound returns the documented 404 payload", async () => {
  const response = draftNotFound();
  assert.equal(response.status, 404);
  const data = await body(response);
  assert.equal(data.error, "draft_not_found");
});
