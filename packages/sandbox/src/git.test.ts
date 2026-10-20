import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import type {
  CheckpointId,
  ExecChunk,
  ExecOptions,
  ProcId,
  ReadRange,
  Sandbox,
} from "./index";
import {
  GitError,
  validateBranchName,
  validateRepoFile,
  validateRepoPath,
  validateRepositoryUrl,
  WorkspaceGit,
} from "./git";

/** Test-only sandbox that executes commands inside a temporary directory. */
class LocalSandbox implements Sandbox {
  readonly id = "local-test";
  constructor(readonly root: string) {}

  async start(): Promise<void> {}
  async suspend(): Promise<void> {}
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  async *exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const cwd = this.resolve(opts?.cwd ?? ".");
    const child = spawnShell(cmd, cwd, opts?.env);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = opts?.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (timer) clearTimeout(timer);
    if (stdout) yield { stream: "stdout", data: stdout };
    if (stderr) yield { stream: "stderr", data: stderr };
    if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms`);
    if (code !== 0) {
      yield {
        stream: "stderr",
        data: `\n[buildx: command exited with code ${code}]\n`,
      };
    }
  }

  async readFile(path: string, _range?: ReadRange): Promise<string> {
    return readFile(this.resolve(path), "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async startBackground(_cmd: string): Promise<ProcId> {
    return "bg";
  }
  async checkpoint(_label: string): Promise<CheckpointId> {
    return "checkpoint";
  }
  async restore(_id: CheckpointId): Promise<void> {}
  async previewUrl(port: number): Promise<string> {
    return `http://localhost:${port}`;
  }

  private resolve(rel: string): string {
    const full = resolve(this.root, rel);
    const inside = relative(this.root, full);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`path escapes test root: ${rel}`);
    }
    return full;
  }
}

function spawnShell(
  cmd: string,
  cwd: string,
  env?: Record<string, string>,
): ReturnType<typeof spawn> {
  return spawn("sh", ["-c", cmd], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function createRepo(): Promise<{ root: string; sandbox: LocalSandbox; git: WorkspaceGit }> {
  const root = await mkdtemp(join(tmpdir(), "buildx-git-"));
  gitCli(root, ["init", "-q", "-b", "main"]);
  const sandbox = new LocalSandbox(root);
  return { root, sandbox, git: new WorkspaceGit(sandbox) };
}

function gitCli(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function initialCommit(git: WorkspaceGit, root: string): Promise<void> {
  await write(root, "README.md", "# Demo\n");
  await git.stageAndCommit({
    path: ".",
    files: ["README.md"],
    message: "Initial commit",
  });
}

function isGitError(code: string) {
  return (error: unknown) =>
    error instanceof GitError && error.code === code;
}

test("repository summary lists branches and creates a feature branch from a base", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await initialCommit(git, root);

    const initial = await git.getRepository(".");
    assert.equal(initial.currentBranch, "main");
    assert.deepEqual(initial.branches.local, ["main"]);
    assert.equal(initial.status.clean, true);
    assert.equal(initial.commits[0]?.subject, "Initial commit");

    const created = await git.createBranch({
      path: ".",
      branch: "feature/login",
      base: "main",
    });
    assert.equal(created.currentBranch, "feature/login");
    assert.deepEqual(created.branches.local, ["feature/login", "main"]);

    const switched = await git.switchBranch({ path: ".", branch: "main" });
    assert.equal(switched.currentBranch, "main");

    await mkdir(join(root, "repos"), { recursive: true });
    gitCli(root, ["init", "-q", "repos/widgets"]);
    const repositories = await git.listRepositories();
    assert.deepEqual(repositories, [
      { path: ".", name: "workspace" },
      { path: "repos/widgets", name: "widgets" },
    ]);
  } finally {
    await sandbox.destroy();
  }
});

test("switch is rejected for a dirty working tree with the changed files", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await initialCommit(git, root);
    await git.createBranch({ path: ".", branch: "feature/dirty", base: "main" });
    await write(root, "README.md", "# Demo changed\n");

    await assert.rejects(
      git.switchBranch({ path: ".", branch: "main" }),
      (error: unknown) => {
        assert.ok(error instanceof GitError);
        assert.equal(error.code, "dirty_working_tree");
        assert.deepEqual(error.changedFiles, ["README.md"]);
        return true;
      },
    );
  } finally {
    await sandbox.destroy();
  }
});

test("diff reflects the working tree and only selected files are committed", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await write(root, "a.txt", "one\n");
    await write(root, "b.txt", "two\n");
    await git.stageAndCommit({
      path: ".",
      files: ["a.txt", "b.txt"],
      message: "Initial files",
    });

    await write(root, "a.txt", "one\nchanged\n");
    await write(root, "b.txt", "two\nchanged\n");
    await write(root, "c.txt", "new\n");

    const dirty = await git.getRepository(".");
    assert.equal(dirty.status.clean, false);
    assert.match(dirty.diff, /\+changed/);
    assert.ok(dirty.status.changedFiles.some((file) => file.path === "a.txt"));
    assert.ok(dirty.status.changedFiles.some((file) => file.path === "c.txt"));

    const result = await git.stageAndCommit({
      path: ".",
      files: ["a.txt"],
      message: "Update a only",
    });
    assert.equal(result.commit.subject, "Update a only");
    assert.ok(result.commit.hash.length >= 7);

    const after = await git.getRepository(".");
    assert.ok(!after.status.changedFiles.some((file) => file.path === "a.txt"));
    assert.ok(after.status.changedFiles.some((file) => file.path === "b.txt"));
    assert.ok(after.status.changedFiles.some((file) => file.path === "c.txt"));
    assert.equal(after.commits[0]?.subject, "Update a only");
  } finally {
    await sandbox.destroy();
  }
});

test("pull-request draft is generated from real changes and persisted locally", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await initialCommit(git, root);
    await git.createBranch({
      path: ".",
      branch: "feature/add-search",
      base: "main",
    });
    await write(root, "src/search.ts", "export const search = () => 'query';\n");
    await git.stageAndCommit({
      path: ".",
      files: ["src/search.ts"],
      message: "Add workspace search",
    });

    const draft = await git.preparePullRequest({
      path: ".",
      base: "main",
      head: "feature/add-search",
    });

    assert.equal(draft.repoPath, ".");
    assert.equal(draft.baseBranch, "main");
    assert.equal(draft.headBranch, "feature/add-search");
    assert.equal(draft.title, "Add workspace search");
    assert.equal(draft.status, "push_required");
    assert.equal(draft.remoteRef, null);
    assert.ok(draft.unpushedCommits >= 1);
    assert.deepEqual(draft.commits, ["Add workspace search"]);
    assert.deepEqual(draft.changedFiles, ["src/search.ts"]);
    assert.match(draft.diff ?? "", /export const search/);
    assert.match(draft.description, /Local draft only/i);
    assert.match(draft.description, /Nothing was pushed/i);
    assert.match(draft.description, /no remote pull request/i);
    assert.match(draft.description, /Add workspace search/);
    assert.ok(draft.createdAt > 0);
    assert.ok(draft.updatedAt >= draft.createdAt);

    const stored = await readFile(
      join(
        root,
        ".buildx/pr-drafts",
        `${createHash("sha256")
          .update(".\0feature/add-search")
          .digest("hex")
          .slice(0, 32)}.json`,
      ),
      "utf8",
    );
    assert.match(stored, /feature\/add-search/);

    const loaded = await git.loadDraft(".", "feature/add-search");
    assert.ok(loaded);
    assert.equal(loaded.title, draft.title);
    assert.equal(loaded.status, "push_required");
    assert.equal(loaded.createdAt, draft.createdAt);

    const updated = await git.updatePullRequestDraft({
      path: ".",
      base: "main",
      head: "feature/add-search",
      title: "Add workspace search (draft)",
      description: "Edited description. Local draft only; nothing pushed.",
    });
    assert.equal(updated.title, "Add workspace search (draft)");
    assert.equal(updated.status, "push_required");
    assert.equal(updated.createdAt, draft.createdAt);
    assert.equal(updated.remoteRef, null);
  } finally {
    await sandbox.destroy();
  }
});

test("draft status is honest about remote tracking and unpushed commits", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await initialCommit(git, root);
    const remote = join(root, "..", `${basename(root)}-remote.git`);
    gitCli(root, ["init", "--bare", "-q", remote]);
    gitCli(root, ["remote", "add", "origin", remote]);
    gitCli(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    gitCli(root, ["branch", "--set-upstream-to=origin/main", "main"]);

    const upToDate = await git.preparePullRequest({
      path: ".",
      base: "main",
      head: "main",
    });
    assert.equal(upToDate.remoteRef, "origin/main");
    assert.equal(upToDate.status, "draft");
    assert.equal(upToDate.unpushedCommits, 0);

    await write(root, "src/next.ts", "export const next = true;\n");
    await git.stageAndCommit({
      path: ".",
      files: ["src/next.ts"],
      message: "Add next",
    });

    const ahead = await git.preparePullRequest({
      path: ".",
      base: "main",
      head: "main",
    });
    assert.equal(ahead.status, "push_required");
    assert.equal(ahead.unpushedCommits, 1);
    assert.match(ahead.description, /ahead of origin\/main/);
  } finally {
    await sandbox.destroy();
    await rm(join(root, "..", `${basename(root)}-remote.git`), {
      recursive: true,
      force: true,
    });
  }
});

test("repository URL validation accepts public https and rejects unsafe forms", () => {
  assert.equal(
    validateRepositoryUrl("https://github.com/acme/widgets.git"),
    "https://github.com/acme/widgets.git",
  );

  const rejected = [
    "http://github.com/acme/widgets.git",
    "file:///tmp/widgets",
    "ssh://git@github.com/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "https://user:secret@github.com/acme/widgets.git",
    "https://github.com/acme/widgets.git;rm -rf /",
    "https://github.com/acme/widgets.git$(whoami)",
    "-https://github.com/acme/widgets.git",
    "https:///acme/widgets.git",
  ];
  for (const url of rejected) {
    assert.throws(() => validateRepositoryUrl(url), isGitError("invalid_url"), url);
  }
});

test("branch, repo path, and file path validation reject unsafe values", () => {
  assert.equal(validateBranchName("feature/add-search"), "feature/add-search");
  assert.equal(validateRepoPath("repos/widgets"), "repos/widgets");
  assert.equal(validateRepoFile("src/search.ts"), "src/search.ts");

  for (const branch of [
    "-main",
    "feature..x",
    "feature x",
    "feature~x",
    "feature^x",
    "feature:x",
    "feature?x",
    "feature*x",
    "feature[x",
    "feature\\x",
    "feature/",
    "feature.",
    "feature.lock",
    "feature@{x",
  ]) {
    assert.throws(() => validateBranchName(branch), isGitError("invalid_branch"), branch);
  }

  for (const path of ["../escape", "/absolute", "repos/../../escape", "-flag"]) {
    assert.throws(() => validateRepoPath(path), isGitError("invalid_path"), path);
    assert.throws(() => validateRepoFile(path), isGitError("invalid_path"), path);
  }
});

test("clone builds a quoted command from an argv array with a fake sandbox", async () => {
  const sandbox = new RecordingSandbox();
  const git = new WorkspaceGit(sandbox);

  const result = await git.clone("https://github.com/acme/widgets.git");
  assert.equal(result.repoPath, "repos/widgets");
  assert.equal(result.repo.path, "repos/widgets");

  const cloneCommand = sandbox.commands.find((cmd) => /'git' 'clone'/.test(cmd));
  assert.ok(cloneCommand, "clone command was executed");
  assert.match(
    cloneCommand,
    /'git' 'clone' '--' 'https:\/\/github\.com\/acme\/widgets\.git' 'repos\/widgets'/,
  );
  assert.ok(
    sandbox.commands.every((cmd) => !cmd.includes(";rm")),
    "no raw shell syntax leaks through",
  );
});

test("clone never overwrites an existing path or repository", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await mkdir(join(root, "repos", "existing"), { recursive: true });
    await assert.rejects(
      git.clone("https://example.com/acme/existing.git"),
      isGitError("path_exists"),
    );

    gitCli(root, ["init", "-q", "repos/already-a-repo"]);
    await assert.rejects(
      git.clone("https://example.com/acme/already-a-repo.git"),
      isGitError("repository_exists"),
    );
  } finally {
    await sandbox.destroy();
  }
});

test("missing repositories and branches return typed errors", async () => {
  const { root, sandbox, git } = await createRepo();
  try {
    await initialCommit(git, root);
    await assert.rejects(
      git.getRepository("repos/missing"),
      isGitError("not_a_repository"),
    );
    await assert.rejects(
      git.switchBranch({ path: ".", branch: "no-such-branch" }),
      isGitError("branch_not_found"),
    );
    await assert.rejects(
      git.createBranch({ path: ".", branch: "feature/x", base: "no-such-base" }),
      isGitError("branch_not_found"),
    );
  } finally {
    await sandbox.destroy();
  }
});

/** Minimal fake sandbox that records commands and answers like a healthy repo. */
class RecordingSandbox implements Sandbox {
  readonly id = "recording";
  commands: string[] = [];

  async *exec(cmd: string, _opts?: ExecOptions): AsyncIterable<ExecChunk> {
    this.commands.push(cmd);
    const flat = cmd.replace(/['"]/g, "");
    let stdout = "";
    let code = 0;

    if (flat.includes("test -e")) {
      code = 1;
    } else if (flat.includes("test -d")) {
      code = 0;
    } else if (flat.includes("git clone")) {
      stdout = "Cloning into 'widgets'...\n";
    } else if (flat.includes("rev-parse --show-prefix")) {
      stdout = "\n";
    } else if (flat.includes("symbolic-ref")) {
      stdout = "main\n";
    } else if (flat.includes("refs/heads")) {
      stdout = "main\n";
    } else if (flat.includes("refs/remotes")) {
      stdout = "";
    } else if (flat.includes("status --porcelain")) {
      stdout = "";
    } else if (flat.includes("@{u}")) {
      code = 1;
    } else if (flat.includes("rev-list --count")) {
      stdout = "1\n";
    } else if (flat.includes("diff")) {
      stdout = "";
    } else if (flat.includes("log")) {
      stdout = "abc1234\tInitial commit\n";
    } else if (flat.includes("remote get-url") || flat.includes("remote")) {
      code = 1;
    }

    if (stdout) yield { stream: "stdout", data: stdout };
    yield {
      stream: "stdout",
      data: `\n__BUILDX_GIT_EXIT__${code}\n`,
    };
  }

  async readFile(_path: string, _range?: ReadRange): Promise<string> {
    return "";
  }
  async writeFile(_path: string, _content: string): Promise<void> {}
  async start(): Promise<void> {}
  async suspend(): Promise<void> {}
  async destroy(): Promise<void> {}
  async startBackground(_cmd: string): Promise<ProcId> {
    return "bg";
  }
  async checkpoint(_label: string): Promise<CheckpointId> {
    return "checkpoint";
  }
  async restore(_id: CheckpointId): Promise<void> {}
  async previewUrl(port: number): Promise<string> {
    return `http://localhost:${port}`;
  }
}
