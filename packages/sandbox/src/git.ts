import { createHash } from "node:crypto";
import { basename, dirname } from "node:path/posix";
import type {
  ExecChunk,
  Sandbox,
  SessionHandle,
} from "./index";

/**
 * Local Git operations inside a workspace sandbox.
 *
 * Every command is built from an argv array and POSIX single-quoted before it
 * reaches `Sandbox.exec` (`sh -c`). Untrusted values (repository URLs, branch
 * names, paths, commit messages) are validated first and never concatenated
 * into a shell string raw. Local panel actions never push. Publishing uses the
 * explicit `fetch` / `stageAllAndCommit` / `mergeUnrelatedOurs` / `push`
 * methods and passes credentials through a command-scoped environment (or a
 * non-shell session where the backend supports one) instead of argv.
 */

export type GitErrorCode =
  | "invalid_url"
  | "invalid_branch"
  | "invalid_path"
  | "not_a_repository"
  | "path_exists"
  | "repository_exists"
  | "branch_exists"
  | "branch_not_found"
  | "dirty_working_tree"
  | "clone_failed"
  | "checkout_failed"
  | "git_missing"
  | "timeout"
  | "command_failed";

/** Typed failure with a stable `code` for API status mapping. */
export class GitError extends Error {
  readonly code: GitErrorCode;
  /** Changed files for `dirty_working_tree` (workspace-relative). */
  readonly changedFiles?: string[];

  constructor(
    code: GitErrorCode,
    message: string,
    options: { changedFiles?: string[] } = {},
  ) {
    super(message);
    this.name = "GitError";
    this.code = code;
    if (options.changedFiles) this.changedFiles = options.changedFiles;
  }
}

export interface GitChangedFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatusSummary {
  clean: boolean;
  changedFiles: GitChangedFile[];
  ahead: number;
  behind: number;
  upstream: string | null;
  unpushedCommits: number;
}

export interface GitBranches {
  local: string[];
  remote: string[];
  current: string | null;
}

export interface GitCommitSummary {
  hash: string;
  subject: string;
}

export interface GitRepositorySummary {
  path: string;
  currentBranch: string | null;
  branches: GitBranches;
  status: GitStatusSummary;
  diff: string;
  diffTruncated: boolean;
  commits: GitCommitSummary[];
  /** True when more than the captured 20 commits exist. */
  commitsTruncated?: boolean;
  remoteUrl: string | null;
}

export interface GitRepositoryInfo {
  path: string;
  name: string;
}

export interface GitCloneResult {
  repoPath: string;
  repo: GitRepositorySummary;
}

export type PullRequestStatus = "draft" | "push_required";

export interface PullRequestDraft {
  repoPath: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  description: string;
  status: PullRequestStatus;
  remoteRef: string | null;
  unpushedCommits: number;
  changedFiles: string[];
  commits: string[];
  diff?: string;
  diffTruncated?: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface PreparePullRequestInput {
  path: string;
  base: string;
  head: string;
}

export interface UpdatePullRequestInput extends PreparePullRequestInput {
  title: string;
  description: string;
}

export interface StageCommitResult {
  commit: GitCommitSummary;
  repo: GitRepositorySummary;
}

const NORMAL_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;
const DIFF_LIMIT = 200_000;
const COMMIT_LIMIT = 20;
const FILE_LIMIT = 200;
const EXIT_MARKER = "__BUILDX_GIT_EXIT__";
const PR_DRAFT_DIR = ".buildx/pr-drafts";
const GIT_CREDENTIAL_HELPER =
  '!f() { echo username="$BUILDX_GIT_USERNAME"; echo password="$BUILDX_GIT_TOKEN"; }; f';

/** True when a value contains ASCII control characters (including NUL). */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** POSIX single-quote a value so it is safe inside `sh -c`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build a shell command from an argv array with single-quoting. */
export function buildCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error("empty command");
  return argv.map(shellQuote).join(" ");
}

/**
 * Validate a public repository URL. Only absolute HTTPS URLs without embedded
 * credentials are accepted; shell metacharacters and leading dashes are
 * rejected (defence in depth on top of single-quoting).
 */
export function validateRepositoryUrl(value: string): string {
  const url = value.trim();
  if (!url) throw new GitError("invalid_url", "Repository URL is required.");
  if (url.startsWith("-")) {
    throw new GitError("invalid_url", "Repository URL must not start with a dash.");
  }
  if (/\s/.test(url) || hasControlCharacters(url)) {
    throw new GitError("invalid_url", "Repository URL must not contain whitespace or control characters.");
  }
  if (!/^https:\/\/[^/]/i.test(url)) {
    throw new GitError("invalid_url", "Repository URL must be an absolute https URL.");
  }
  // Shell / glob metacharacters are never needed in a clone URL and are a sign
  // that the caller is trying to smuggle shell syntax through.
  if (/[;&|`$<>(){}[\]\\'"!*?~^#]/.test(url)) {
    throw new GitError("invalid_url", "Repository URL contains unsupported characters.");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitError("invalid_url", "Repository URL must be an absolute https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new GitError("invalid_url", "Repository URL must use https.");
  }
  if (!parsed.hostname) {
    throw new GitError("invalid_url", "Repository URL must include a host.");
  }
  if (parsed.username || parsed.password) {
    throw new GitError(
      "invalid_url",
      "Repository URL must not embed credentials. Use a public URL or configure access outside BuildX.",
    );
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    throw new GitError("invalid_url", "Repository URL must point at a repository path.");
  }
  return parsed.toString();
}

/** Safe default clone directory name, e.g. `repos/buildx`. */
export function safeRepoName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/, 1)[0] ?? "";
  }
  const raw = pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const name = decoded
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return name && name !== "." && name !== ".." ? name.slice(0, 100) : "repo";
}

/** Validate a git branch / remote-tracking ref name. */
export function validateBranchName(value: string): string {
  const name = value.trim();
  if (!name) throw new GitError("invalid_branch", "Branch name is required.");
  if (name.length > 255) {
    throw new GitError("invalid_branch", "Branch name is too long.");
  }
  if (
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name === "@" ||
    name === "." ||
    name === ".."
  ) {
    throw new GitError("invalid_branch", `Invalid branch name: ${name}`);
  }
  if (/\s/.test(name) || hasControlCharacters(name)) {
    throw new GitError("invalid_branch", "Branch names must not contain whitespace or control characters.");
  }
  if (/[~^:?*[\]\\]/.test(name) || name.includes("..") || name.includes("@{")) {
    throw new GitError("invalid_branch", `Invalid branch name: ${name}`);
  }
  for (const segment of name.split("/")) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.endsWith(".lock")
    ) {
      throw new GitError("invalid_branch", `Invalid branch name: ${name}`);
    }
  }
  return name;
}

/** Validate a git remote name (e.g. `origin`). */
export function validateRemoteName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100 || name.startsWith("-")) {
    throw new GitError("invalid_path", "Invalid git remote name.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new GitError("invalid_path", `Invalid git remote name: ${name}`);
  }
  return name;
}

/** Environment for one-shot HTTPS credentials; never included in git argv. */
function credentialEnv(auth: GitAuth): Record<string, string> {
  if (!auth.username || !auth.token) {
    throw new GitError("invalid_path", "Git credentials are required.");
  }
  return {
    BUILDX_GIT_USERNAME: auth.username,
    BUILDX_GIT_TOKEN: auth.token,
  };
}

/** Normalize + validate a workspace-relative repository path. */
export function validateRepoPath(value: string, options: { allowRoot?: boolean } = {}): string {
  const raw = value.trim();
  if (!raw) throw new GitError("invalid_path", "Repository path is required.");
  if (raw.startsWith("-")) {
    throw new GitError("invalid_path", "Repository path must not start with a dash.");
  }
  if (hasControlCharacters(raw)) {
    throw new GitError("invalid_path", "Repository path contains control characters.");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new GitError("invalid_path", "Repository path must be workspace-relative.");
  }
  let normalized = raw.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized) normalized = ".";
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new GitError("invalid_path", "Repository path must not escape the workspace.");
  }
  if (!options.allowRoot && normalized === ".") {
    throw new GitError("invalid_path", "A repository path inside the workspace is required.");
  }
  return normalized;
}

/** Validate one explicitly selected workspace-relative file path. */
export function validateRepoFile(value: string): string {
  const raw = value.trim();
  if (!raw) throw new GitError("invalid_path", "File path is required.");
  if (raw.startsWith("-")) {
    throw new GitError("invalid_path", "File paths must not start with a dash.");
  }
  if (hasControlCharacters(raw)) {
    throw new GitError("invalid_path", "File path contains control characters.");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new GitError("invalid_path", "File paths must be workspace-relative.");
  }
  let normalized = raw.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === ".") {
    throw new GitError("invalid_path", "File path is required.");
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new GitError("invalid_path", "File paths must not escape the workspace.");
  }
  return normalized;
}

/** Parse `git status --porcelain=v1 -z` into changed files. */
export function parseChangedFiles(raw: string): GitChangedFile[] {
  const tokens = raw.split("\0");
  const files: GitChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // With -z a rename/copy prints the destination first, then the source.
    if (xy[0] === "R" || xy[0] === "C") index += 1;
    files.push({
      path,
      status: xy.trim() || "?",
      staged: xy[0] !== " " && xy[0] !== "?",
    });
  }
  return files;
}

/** Parse newline-delimited branch names, dropping symbolic remote HEAD. */
export function parseBranchList(raw: string, kind: "local" | "remote"): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => !(kind === "remote" && name.endsWith("/HEAD")))
    .sort();
}

/** Parse `git log --format=%H%x09%s` output. */
export function parseCommitList(raw: string): GitCommitSummary[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return { hash: line, subject: "" };
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/** Cap text and report whether anything was dropped. */
export function capOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/** Stable path for a local PR draft: hash of repo path + head branch. */
export function pullRequestDraftPath(repoPath: string, headBranch: string): string {
  const hash = createHash("sha256")
    .update(`${repoPath}\0${headBranch}`)
    .digest("hex")
    .slice(0, 32);
  return `${PR_DRAFT_DIR}/${hash}.json`;
}

/** Remove credentials (and query/fragment) from a configured remote URL. */
export function sanitizeRemoteUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^@/]+@/, "//");
  }
}

/** Human-friendly title fallback from a branch name. */
export function titleFromBranch(branch: string): string {
  const leaf = branch.split("/").pop() ?? branch;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  if (!words) return `Changes from ${branch}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function humanizeStatus(status: string): string {
  switch (status.charAt(0)) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    default:
      return "modified";
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Credentials used only for a single network command; never persisted. */
export interface GitAuth {
  username: string;
  token: string;
}

interface NameStatusEntry {
  status: string;
  path: string;
}

interface PreparedChanges {
  commits: GitCommitSummary[];
  commitsTruncated: boolean;
  files: NameStatusEntry[];
  filesTruncated: boolean;
  additions: number;
  deletions: number;
  diff: string;
  diffTruncated: boolean;
}

/** A reusable local Git service over a workspace `Sandbox`. */
export class WorkspaceGit {
  constructor(private readonly sandbox: Sandbox) {}

  /**
   * Clone an HTTPS repository into `repos/<name>` (or `directory`). Pass
   * `auth` for private repositories; credentials travel in the backend's
   * secure session and never appear in the clone URL or git config.
   */
  async clone(
    url: string,
    directory?: string,
    auth?: GitAuth,
  ): Promise<GitCloneResult> {
    const safeUrl = validateRepositoryUrl(url);
    const repoPath = directory
      ? validateRepoPath(directory)
      : `repos/${safeRepoName(safeUrl)}`;

    if (await this.pathExists(repoPath)) {
      if (await this.isRepository(repoPath)) {
        throw new GitError(
          "repository_exists",
          `A git repository already exists at ${repoPath}.`,
        );
      }
      throw new GitError(
        "path_exists",
        `The path ${repoPath} already exists and is not a git repository.`,
      );
    }

    const parent = dirname(repoPath);
    if (parent && parent !== ".") await this.ensureDirectory(parent);

    const options = { timeoutMs: CLONE_TIMEOUT_MS };
    const result = auth
      ? await this.runNetworkGit(["clone", "--", safeUrl, repoPath], options, auth)
      : await this.runGit(["clone", "--", safeUrl, repoPath], options);
    if (result.code !== 0) {
      throw new GitError(
        "clone_failed",
        `git clone failed: ${describe(result)}`,
      );
    }
    if (!(await this.isRepository(repoPath))) {
      throw new GitError(
        "clone_failed",
        "git clone finished but the target is not a git repository.",
      );
    }
    return { repoPath, repo: await this.getRepository(repoPath) };
  }

  /** Initialize a fresh repository at `path` on `branch` (default `main`). */
  async initialize(input: {
    path?: string;
    branch?: string;
  } = {}): Promise<GitRepositorySummary> {
    const repoPath = validateRepoPath(input.path ?? ".", { allowRoot: true });
    const branch = validateBranchName(input.branch ?? "main");
    if (await this.isRepository(repoPath)) {
      throw new GitError(
        "repository_exists",
        `${repoPath === "." ? "The workspace root" : repoPath} is already a git repository.`,
      );
    }
    if (repoPath !== ".") await this.ensureDirectory(repoPath);
    const result = await this.runGit(["init", "-b", branch], {
      cwd: repoPath,
    });
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `Could not initialize ${repoPath}: ${describe(result)}`,
      );
    }
    await this.ensureBuildxExcludes(repoPath);
    return this.getRepository(repoPath);
  }

  /** Add or replace a named remote with a credential-free HTTPS URL. */
  async setRemote(input: {
    path?: string;
    name?: string;
    url: string;
  }): Promise<void> {
    const repoPath = await this.requireRepository(input.path ?? ".");
    const name = validateRemoteName(input.name ?? "origin");
    const url = validateRepositoryUrl(input.url);
    const existing = await this.runGit(["remote", "get-url", name], {
      cwd: repoPath,
    });
    const result = await this.runGit(
      existing.code === 0
        ? ["remote", "set-url", name, url]
        : ["remote", "add", name, url],
      { cwd: repoPath },
    );
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `Could not configure remote ${name}: ${describe(result)}`,
      );
    }
  }

  /** Fetch a remote (optionally one branch) with one-shot credentials. */
  async fetch(input: {
    path: string;
    remote?: string;
    branch?: string;
    auth?: GitAuth;
  }): Promise<void> {
    const repoPath = await this.requireRepository(input.path);
    const remote = validateRemoteName(input.remote ?? "origin");
    const branch = input.branch ? validateBranchName(input.branch) : undefined;
    const args = [
      "fetch",
      "--prune",
      remote,
      ...(branch ? [branch] : []),
    ];
    const options = {
      cwd: repoPath,
      timeoutMs: CLONE_TIMEOUT_MS,
    };
    const result = input.auth
      ? await this.runNetworkGit(args, options, input.auth)
      : await this.runGit(args, options);
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `Could not fetch ${remote}: ${describe(result)}`,
      );
    }
  }

  /**
   * Stage every workspace change and commit it. Repositories initialized by
   * BuildX also ignore bookkeeping and dependency/build folders locally. Used
   * by the publish tool, not the local Git panel.
   */
  async stageAllAndCommit(input: {
    path: string;
    message: string;
  }): Promise<StageCommitResult> {
    const repoPath = await this.requireRepository(input.path);
    const message = input.message.trim();
    if (!message) {
      throw new GitError("invalid_path", "A commit message is required.");
    }
    if (message.length > 500 || message.includes("\0")) {
      throw new GitError("invalid_path", "Commit message is invalid or too long.");
    }

    // New repositories get `.git/info/exclude` entries for generated folders;
    // existing repositories keep their own .gitignore choices.
    const add = await this.runGit(["add", "-A", "--", "."], {
      cwd: repoPath,
    });
    if (add.code !== 0) {
      throw new GitError(
        "invalid_path",
        `Could not stage workspace files: ${describe(add)}`,
      );
    }

    const commit = await this.runGit(
      [
        "-c",
        "user.name=BuildX",
        "-c",
        "user.email=buildx@users.noreply.github.com",
        "commit",
        "-m",
        message,
      ],
      { cwd: repoPath },
    );
    if (commit.code !== 0) {
      const text = describe(commit);
      throw new GitError(
        "command_failed",
        /nothing to commit|no changes added|nothing added to commit/i.test(text)
          ? "There are no workspace changes to commit."
          : `Commit failed: ${text}`,
      );
    }

    const hash = await this.runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    const subject = await this.runGit(
      ["log", "-1", "--format=%s", "HEAD"],
      { cwd: repoPath },
    );
    return {
      commit: {
        hash: hash.stdout.trim(),
        subject: subject.stdout.trim(),
      },
      repo: await this.getRepository(repoPath),
    };
  }

  /**
   * Join unrelated histories, preferring local files on conflicts and keeping
   * the remote base as a parent. Used when publishing a new project on top of a
   * repository created with an initial commit.
   */
  async mergeUnrelatedOurs(input: {
    path: string;
    ref: string;
  }): Promise<void> {
    const repoPath = await this.requireRepository(input.path);
    const ref = validateBranchName(input.ref);
    const result = await this.runGit(
      [
        "-c",
        "user.name=BuildX",
        "-c",
        "user.email=buildx@users.noreply.github.com",
        "merge",
        "--allow-unrelated-histories",
        "-X",
        "ours",
        "--no-edit",
        ref,
      ],
      { cwd: repoPath },
    );
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `Could not join ${ref} with the workspace history: ${describe(result)}`,
      );
    }
  }

  /**
   * Push a branch with credentials supplied through the process environment.
   * The token never appears in argv, command text, or git config.
   */
  async push(input: {
    path: string;
    remote?: string;
    branch: string;
    auth: GitAuth;
  }): Promise<{ remote: string; branch: string }> {
    const repoPath = await this.requireRepository(input.path);
    const remote = validateRemoteName(input.remote ?? "origin");
    const branch = validateBranchName(input.branch);
    const result = await this.runNetworkGit(
      ["push", "--set-upstream", remote, branch],
      {
        cwd: repoPath,
        timeoutMs: CLONE_TIMEOUT_MS,
      },
      input.auth,
    );
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `Could not push ${branch} to ${remote}: ${describe(result)}`,
      );
    }
    return { remote, branch };
  }

  /** Hide BuildX bookkeeping and generated dependency/build folders locally. */
  private async ensureBuildxExcludes(repoPath: string): Promise<void> {
    const file =
      repoPath === "."
        ? ".git/info/exclude"
        : `${repoPath}/.git/info/exclude`;
    let existing: string;
    try {
      existing = await this.sandbox.readFile(file);
    } catch {
      existing = "";
    }
    const marker = "# BuildX local-only artifacts";
    if (existing.includes(marker)) return;
    const patterns = [
      marker,
      ".buildx/",
      "node_modules/",
      ".next/",
      "dist/",
      "build/",
      "coverage/",
      ".env",
      ".env.*",
      "!.env.example",
    ];
    const content = `${existing.replace(/\s*$/, "")}\n${patterns.join("\n")}\n`;
    await this.sandbox.writeFile(file, content);
  }

  /** True when `path` (workspace-relative) is inside a git work tree. */
  async isRepository(path: string): Promise<boolean> {
    const repoPath = validateRepoPath(path, { allowRoot: true });
    if (repoPath !== "." && !(await this.pathExists(repoPath, "dir"))) {
      return false;
    }
    // `--show-prefix` is empty only when `path` is the root of a work tree.
    // Being merely inside a parent repository (e.g. an ordinary subdirectory)
    // must not make a clone target look like an existing repository.
    const result = await this.runGit(["rev-parse", "--show-prefix"], {
      cwd: repoPath,
    });
    return result.code === 0 && result.stdout.trim() === "";
  }

  /** Repositories under `repos/`, plus the workspace root when it is a repo. */
  async listRepositories(): Promise<GitRepositoryInfo[]> {
    const repositories: GitRepositoryInfo[] = [];
    if (await this.isRepository(".")) {
      repositories.push({ path: ".", name: "workspace" });
    }

    if (await this.pathExists("repos", "dir")) {
      const result = await this.run(
        ["find", "repos", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print"],
        { timeoutMs: NORMAL_TIMEOUT_MS },
      );
      if (result.code === 0) {
        for (const line of result.stdout.split("\n")) {
          const candidate = line.trim();
          if (!candidate) continue;
          if (!(await this.isRepository(candidate))) continue;
          repositories.push({ path: candidate, name: basename(candidate) });
        }
      }
    }
    return repositories.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Branch list, working-tree status, diff, recent commits, and remote URL. */
  async getRepository(path: string): Promise<GitRepositorySummary> {
    const repoPath = await this.requireRepository(path);

    const branch = await this.runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repoPath },
    );
    const currentBranch = branch.code === 0 ? branch.stdout.trim() || null : null;

    const localRefs = await this.runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd: repoPath },
    );
    const remoteRefs = await this.runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      { cwd: repoPath },
    );
    const local = localRefs.code === 0 ? parseBranchList(localRefs.stdout, "local") : [];
    const remote = remoteRefs.code === 0 ? parseBranchList(remoteRefs.stdout, "remote") : [];

    const status = await this.readStatus(repoPath);
    const diff = await this.readWorkingTreeDiff(repoPath);

    const log = await this.runGit(
      ["log", `-n`, String(COMMIT_LIMIT + 1), "--format=%H%x09%s", "--"],
      { cwd: repoPath },
    );
    const allCommits = log.code === 0 ? parseCommitList(log.stdout) : [];
    const commits = allCommits.slice(0, COMMIT_LIMIT);

    return {
      path: repoPath,
      currentBranch,
      branches: { local, remote, current: currentBranch },
      status,
      diff: diff.text,
      diffTruncated: diff.truncated,
      commits,
      commitsTruncated: allCommits.length > COMMIT_LIMIT,
      remoteUrl: await this.readRemoteUrl(repoPath),
    };
  }

  /** Create a local branch from a local or remote-tracking base. */
  async createBranch(input: {
    path: string;
    branch: string;
    base: string;
  }): Promise<GitRepositorySummary> {
    const repoPath = await this.requireRepository(input.path);
    const branch = validateBranchName(input.branch);
    const base = validateBranchName(input.base);

    const existing = await this.runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoPath },
    );
    if (existing.code === 0) {
      throw new GitError("branch_exists", `Branch ${branch} already exists.`);
    }

    if (!(await this.refExists(repoPath, base))) {
      throw new GitError("branch_not_found", `Base branch ${base} was not found.`);
    }

    const result = await this.runGit(["switch", "-c", branch, base], {
      cwd: repoPath,
    });
    if (result.code !== 0) {
      throw new GitError(
        "checkout_failed",
        `Could not create branch ${branch}: ${describe(result)}`,
      );
    }
    return this.getRepository(repoPath);
  }

  /**
   * Ensure a task-specific local branch exists before edits. Preserves
   * pre-existing uncommitted changes, reuses the branch on resume, and never
   * initializes a repository without explicit user approval.
   */
  async ensureTaskBranch(input: {
    path?: string;
    branch: string;
  }): Promise<{
    isRepo: boolean;
    branch: string | null;
    created: boolean;
    reused: boolean;
    status: GitStatusSummary | null;
  }> {
    const repoPath = validateRepoPath(input.path ?? ".", { allowRoot: true });
    const branch = validateBranchName(input.branch);

    if (!(await this.isRepository(repoPath))) {
      return {
        isRepo: false,
        branch: null,
        created: false,
        reused: false,
        status: null,
      };
    }

    const status = await this.readStatus(repoPath);
    const current = await this.runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repoPath },
    );
    const currentBranch =
      current.code === 0 ? current.stdout.trim() || null : null;

    if (currentBranch === branch) {
      return {
        isRepo: true,
        branch,
        created: false,
        reused: true,
        status,
      };
    }

    const exists = await this.refExists(repoPath, `refs/heads/${branch}`);
    if (exists) {
      // Prefer switch; git keeps uncommitted changes when they do not conflict.
      const switched = await this.runGit(["switch", branch], { cwd: repoPath });
      if (switched.code !== 0) {
        throw new GitError(
          "checkout_failed",
          `Could not switch to task branch ${branch} while preserving local changes: ${describe(switched)}`,
        );
      }
      return {
        isRepo: true,
        branch,
        created: false,
        reused: true,
        status: await this.readStatus(repoPath),
      };
    }

    const created = await this.runGit(["switch", "-c", branch], {
      cwd: repoPath,
    });
    if (created.code !== 0) {
      throw new GitError(
        "checkout_failed",
        `Could not create task branch ${branch}: ${describe(created)}`,
      );
    }
    return {
      isRepo: true,
      branch,
      created: true,
      reused: false,
      status: await this.readStatus(repoPath),
    };
  }

  /** Switch to an existing local branch; a dirty tree is rejected. */
  async switchBranch(input: {
    path: string;
    branch: string;
  }): Promise<GitRepositorySummary> {
    const repoPath = await this.requireRepository(input.path);
    const branch = validateBranchName(input.branch);

    const current = await this.runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repoPath },
    );
    const currentBranch = current.code === 0 ? current.stdout.trim() : null;
    if (currentBranch === branch) return this.getRepository(repoPath);

    if (!(await this.refExists(repoPath, `refs/heads/${branch}`))) {
      throw new GitError("branch_not_found", `Branch ${branch} was not found.`);
    }

    const status = await this.readStatus(repoPath);
    if (!status.clean) {
      throw new GitError(
        "dirty_working_tree",
        "The working tree has uncommitted changes. Commit or discard them before switching branches.",
        { changedFiles: status.changedFiles.map((file) => file.path) },
      );
    }

    const result = await this.runGit(["switch", branch], { cwd: repoPath });
    if (result.code !== 0) {
      throw new GitError(
        "checkout_failed",
        `Could not switch to ${branch}: ${describe(result)}`,
      );
    }
    return this.getRepository(repoPath);
  }

  /** Stage only the selected paths and commit them locally. */
  async stageAndCommit(input: {
    path: string;
    files: string[];
    message: string;
  }): Promise<StageCommitResult> {
    const repoPath = await this.requireRepository(input.path);
    const files = [...new Set(input.files.map(validateRepoFile))];
    if (files.length === 0) {
      throw new GitError("invalid_path", "Select at least one file to commit.");
    }
    const message = input.message.trim();
    if (!message) {
      throw new GitError("invalid_path", "A commit message is required.");
    }
    if (message.length > 500 || message.includes("\0")) {
      throw new GitError("invalid_path", "Commit message is invalid or too long.");
    }

    const add = await this.runGit(["add", "--", ...files], { cwd: repoPath });
    if (add.code !== 0) {
      throw new GitError(
        "invalid_path",
        `Could not stage the selected files: ${describe(add)}`,
      );
    }

    const commit = await this.runGit(
      [
        "-c",
        "user.name=BuildX",
        "-c",
        "user.email=buildx@localhost",
        "commit",
        "-m",
        message,
        "--",
        ...files,
      ],
      { cwd: repoPath },
    );
    if (commit.code !== 0) {
      const text = describe(commit);
      const messageText = /nothing to commit|no changes added|nothing added to commit/i.test(text)
        ? "Selected files have no changes to commit."
        : `Commit failed: ${text}`;
      throw new GitError("command_failed", messageText);
    }

    const hash = await this.runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    const subject = await this.runGit(
      ["log", "-1", "--format=%s", "HEAD"],
      { cwd: repoPath },
    );
    return {
      commit: {
        hash: hash.stdout.trim(),
        subject: subject.stdout.trim(),
      },
      repo: await this.getRepository(repoPath),
    };
  }

  /** Build + persist a local-only pull-request draft. Never pushes. */
  async preparePullRequest(
    input: PreparePullRequestInput,
    options: { persist?: boolean } = {},
  ): Promise<PullRequestDraft> {
    const repoPath = await this.requireRepository(input.path);
    const base = validateBranchName(input.base);
    const head = validateBranchName(input.head);

    if (!(await this.refExists(repoPath, base))) {
      throw new GitError("branch_not_found", `Base branch ${base} was not found.`);
    }
    if (!(await this.refExists(repoPath, head))) {
      throw new GitError("branch_not_found", `Head branch ${head} was not found.`);
    }

    const changes = await this.readPreparedChanges(repoPath, base, head);
    const remoteRef = await this.readUpstream(repoPath, head);
    const unpushedCommits = await this.countUnpushed(repoPath, head, remoteRef);
    const pushRequired = !remoteRef || unpushedCommits > 0;
    const status: PullRequestStatus = pushRequired ? "push_required" : "draft";
    const title = proposeTitle(head, changes.commits);
    const notes = pushRequired
      ? `Local draft only. Nothing was pushed and no remote pull request was created. ${
          remoteRef
            ? `${head} has ${unpushedCommits} unpushed commit(s) relative to ${remoteRef}; push it before opening a pull request.`
            : `${head} has no remote-tracking reference; push it before opening a pull request.`
        }`
      : `Local draft only. Nothing was pushed and no remote pull request was created. ${head} is up to date with ${remoteRef}.`;

    const description = buildDescription({
      base,
      head,
      changes,
      pushRequired,
      remoteRef,
      unpushedCommits,
    });

    const existing = await this.loadDraft(repoPath, head);
    const now = Date.now();
    const draft: PullRequestDraft = {
      repoPath,
      baseBranch: base,
      headBranch: head,
      title,
      description,
      status,
      remoteRef,
      unpushedCommits,
      changedFiles: changes.files.map((file) => file.path),
      commits: changes.commits.map((commit) => commit.subject),
      diff: changes.diff,
      diffTruncated: changes.diffTruncated,
      notes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (options.persist === false) return draft;
    return this.saveDraft(draft);
  }

  /**
   * Recompute local push status from real git state, then persist the operator's
   * title/description. A client can never supply `status`, `remoteRef`, or
   * `unpushedCommits`.
   */
  async updatePullRequestDraft(
    input: UpdatePullRequestInput,
  ): Promise<PullRequestDraft> {
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title || title.length > 200) {
      throw new GitError("invalid_path", "Pull-request title is required (max 200 characters).");
    }
    if (!description || description.length > 20_000) {
      throw new GitError(
        "invalid_path",
        "Pull-request description is required (max 20000 characters).",
      );
    }

    const draft = await this.preparePullRequest(input, { persist: false });
    return this.saveDraft({ ...draft, title, description });
  }

  /** Load a persisted draft for a repo + head branch, or `undefined`. */
  async loadDraft(
    repoPath: string,
    headBranch: string,
  ): Promise<PullRequestDraft | undefined> {
    const normalizedPath = validateRepoPath(repoPath, { allowRoot: true });
    const normalizedHead = validateBranchName(headBranch);
    try {
      const raw = await this.sandbox.readFile(
        pullRequestDraftPath(normalizedPath, normalizedHead),
      );
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return undefined;
      const draft = parsed as Partial<PullRequestDraft>;
      if (
        typeof draft.repoPath !== "string" ||
        typeof draft.baseBranch !== "string" ||
        typeof draft.headBranch !== "string" ||
        typeof draft.title !== "string" ||
        typeof draft.description !== "string" ||
        (draft.status !== "draft" && draft.status !== "push_required")
      ) {
        return undefined;
      }
      return draft as PullRequestDraft;
    } catch {
      return undefined;
    }
  }

  /** Persist a draft under `.buildx/pr-drafts/` (creating the directory). */
  async saveDraft(draft: PullRequestDraft): Promise<PullRequestDraft> {
    const repoPath = validateRepoPath(draft.repoPath, { allowRoot: true });
    const head = validateBranchName(draft.headBranch);
    const now = Date.now();
    const stored: PullRequestDraft = {
      ...draft,
      repoPath,
      headBranch: head,
      createdAt: draft.createdAt || now,
      updatedAt: now,
    };

    await this.ensureDirectory(PR_DRAFT_DIR);
    await this.sandbox.writeFile(
      pullRequestDraftPath(repoPath, head),
      `${JSON.stringify(stored, null, 2)}\n`,
    );
    return stored;
  }

  /** Validate `path` and confirm it is a git work tree. */
  async requireRepository(path: string): Promise<string> {
    const repoPath = validateRepoPath(path, { allowRoot: true });
    if (!(await this.isRepository(repoPath))) {
      throw new GitError(
        "not_a_repository",
        `${repoPath === "." ? "The workspace root" : repoPath} is not a git repository.`,
      );
    }
    return repoPath;
  }

  private async readStatus(repoPath: string): Promise<GitStatusSummary> {
    const porcelain = await this.runGit(["status", "--porcelain=v1", "-z"], {
      cwd: repoPath,
    });
    const changedFiles = porcelain.code === 0 ? parseChangedFiles(porcelain.stdout) : [];

    const upstreamResult = await this.runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd: repoPath },
    );
    const upstream =
      upstreamResult.code === 0 ? upstreamResult.stdout.trim() || null : null;

    let ahead = 0;
    let behind = 0;
    let unpushedCommits: number;

    if (upstream) {
      const counts = await this.runGit(
        ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
        { cwd: repoPath },
      );
      if (counts.code === 0) {
        const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
        behind = Number.parseInt(behindRaw ?? "0", 10) || 0;
        ahead = Number.parseInt(aheadRaw ?? "0", 10) || 0;
      }
      unpushedCommits = await this.countUnpushed(repoPath, "HEAD", upstream);
    } else {
      unpushedCommits = await this.countUnpushed(repoPath, "HEAD", null);
    }

    return {
      clean: changedFiles.length === 0,
      changedFiles,
      ahead,
      behind,
      upstream,
      unpushedCommits,
    };
  }

  private async readWorkingTreeDiff(
    repoPath: string,
  ): Promise<{ text: string; truncated: boolean }> {
    const againstHead = await this.runGit(
      ["diff", "--no-color", "HEAD", "--"],
      { cwd: repoPath },
    );
    if (againstHead.code === 0) {
      return capOutput(againstHead.stdout, DIFF_LIMIT);
    }
    // Unborn branch: show staged + unstaged changes separately.
    const staged = await this.runGit(
      ["diff", "--no-color", "--cached", "--"],
      { cwd: repoPath },
    );
    const unstaged = await this.runGit(["diff", "--no-color", "--"], {
      cwd: repoPath,
    });
    return capOutput(`${staged.stdout}${unstaged.stdout}`, DIFF_LIMIT);
  }

  private async readRemoteUrl(repoPath: string): Promise<string | null> {
    const origin = await this.runGit(["remote", "get-url", "origin"], {
      cwd: repoPath,
    });
    if (origin.code === 0 && origin.stdout.trim()) {
      return sanitizeRemoteUrl(origin.stdout.trim());
    }
    const remotes = await this.runGit(["remote"], { cwd: repoPath });
    if (remotes.code !== 0) return null;
    const first = remotes.stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!first) return null;
    const url = await this.runGit(["remote", "get-url", first], {
      cwd: repoPath,
    });
    return url.code === 0 && url.stdout.trim()
      ? sanitizeRemoteUrl(url.stdout.trim())
      : null;
  }

  private async readPreparedChanges(
    repoPath: string,
    base: string,
    head: string,
  ): Promise<PreparedChanges> {
    const log = await this.runGit(
      ["log", `-n`, String(COMMIT_LIMIT + 1), "--format=%H%x09%s", `${base}..${head}`, "--"],
      { cwd: repoPath },
    );
    const allCommits = log.code === 0 ? parseCommitList(log.stdout) : [];
    const commits = allCommits.slice(0, COMMIT_LIMIT);

    const nameStatus = await this.runGit(
      ["diff", "--name-status", "-z", "--no-renames", `${base}..${head}`, "--"],
      { cwd: repoPath },
    );
    const allFiles = nameStatus.code === 0 ? parseNameStatus(nameStatus.stdout) : [];
    const files = allFiles.slice(0, FILE_LIMIT);

    const numstat = await this.runGit(
      ["diff", "--numstat", "-z", `${base}..${head}`, "--"],
      { cwd: repoPath },
    );
    const stats =
      numstat.code === 0
        ? parseNumstat(numstat.stdout)
        : { additions: 0, deletions: 0 };

    const diff = await this.runGit(
      ["diff", "--no-color", `${base}..${head}`, "--"],
      { cwd: repoPath },
    );
    const capped =
      diff.code === 0
        ? capOutput(diff.stdout, DIFF_LIMIT)
        : { text: "", truncated: false };

    return {
      commits,
      commitsTruncated: allCommits.length > COMMIT_LIMIT,
      files,
      filesTruncated: allFiles.length > FILE_LIMIT,
      additions: stats.additions,
      deletions: stats.deletions,
      diff: capped.text,
      diffTruncated: capped.truncated,
    };
  }

  private async readUpstream(repoPath: string, head: string): Promise<string | null> {
    const result = await this.runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${head}@{u}`],
      { cwd: repoPath },
    );
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  private async countUnpushed(
    repoPath: string,
    head: string,
    upstream: string | null,
  ): Promise<number> {
    // With no upstream, count commits not reachable from any remote-tracking
    // ref; a repository without remotes therefore reports every commit.
    const args = upstream
      ? ["rev-list", "--count", `${upstream}..${head}`]
      : ["rev-list", "--count", head, "--not", "--remotes"];
    const result = await this.runGit(args, { cwd: repoPath });
    if (result.code === 0) return Number.parseInt(result.stdout.trim(), 10) || 0;
    if (upstream) return 0;
    const fallback = await this.runGit(["rev-list", "--count", head], {
      cwd: repoPath,
    });
    return fallback.code === 0 ? Number.parseInt(fallback.stdout.trim(), 10) || 0 : 0;
  }

  private async refExists(repoPath: string, ref: string): Promise<boolean> {
    const result = await this.runGit(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd: repoPath },
    );
    return result.code === 0;
  }

  private async ensureDirectory(path: string): Promise<void> {
    const result = await this.run(["mkdir", "-p", path], {
      timeoutMs: NORMAL_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new GitError(
        "command_failed",
        `Could not create directory ${path}: ${describe(result)}`,
      );
    }
  }

  private async pathExists(
    path: string,
    kind: "any" | "dir" = "any",
  ): Promise<boolean> {
    const result = await this.run(
      ["test", kind === "dir" ? "-d" : "-e", path],
      { timeoutMs: NORMAL_TIMEOUT_MS },
    );
    return result.code === 0;
  }

  private async runGit(args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const result = await this.run(["git", ...args], options);
    this.assertGitAvailable(result);
    return result;
  }

  /**
   * Run an authenticated network command. The token travels in the backend's
   * environment field for a non-shell session, never in a `sh -c` command.
   * Sandboxes without session support cannot authenticate safely.
   */
  private async runNetworkGit(
    args: string[],
    options: RunOptions,
    auth: GitAuth,
  ): Promise<CommandResult> {
    if (!this.sandbox.openSession) {
      throw new GitError(
        "command_failed",
        "This sandbox backend cannot run authenticated Git commands safely.",
      );
    }
    const result = await this.runGitInSession(args, options, auth);
    this.assertGitAvailable(result);
    return result;
  }

  private async runGitInSession(
    args: string[],
    options: RunOptions,
    auth: GitAuth,
  ): Promise<CommandResult> {
    const openSession = this.sandbox.openSession;
    if (!openSession) {
      throw new GitError("command_failed", "Sandbox sessions are unavailable.");
    }
    let stdout = "";
    let stderr = "";
    let handle: SessionHandle | undefined;
    let timedOut = false;
    try {
      handle = await openSession.call(this.sandbox, {
        argv: [
          "git",
          "-c",
          `credential.helper=${GIT_CREDENTIAL_HELPER}`,
          ...args,
        ],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        tty: false,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "true",
          ...credentialEnv(auth),
        },
        onOutput: (chunk) => {
          if (chunk.stream === "stderr") stderr += chunk.data;
          else stdout += chunk.data;
        },
      });
      const timeoutMs = options.timeoutMs ?? NORMAL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          handle?.kill("KILL");
        } catch {
          // The session may have exited between the timer firing and the kill.
        }
      }, timeoutMs);
      let code: number;
      try {
        code = await handle.wait();
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        throw new GitError(
          "timeout",
          `git command timed out after ${timeoutMs}ms.`,
        );
      }
      return { code, stdout, stderr };
    } catch (error) {
      if (error instanceof GitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/timed? ?out/i.test(message)) {
        throw new GitError(
          "timeout",
          `git command timed out after ${options.timeoutMs ?? NORMAL_TIMEOUT_MS}ms.`,
        );
      }
      throw error;
    } finally {
      try {
        handle?.close();
      } catch {
        // Closing an already-finished session is harmless.
      }
    }
  }

  private assertGitAvailable(result: CommandResult): void {
    if (
      result.code === 127 ||
      /git: (command )?not found|command not found: git/i.test(describe(result))
    ) {
      throw new GitError(
        "git_missing",
        "git is not installed in this workspace sandbox.",
      );
    }
  }

  private async run(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
    const script = `${buildCommand(argv)}; __buildx_git_rc=$?; printf '\\n${EXIT_MARKER}%s\\n' "$__buildx_git_rc"; exit $__buildx_git_rc`;
    let stdout = "";
    let stderr = "";
    try {
      for await (const chunk of this.sandbox.exec(script, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? NORMAL_TIMEOUT_MS,
        // Never block waiting for interactive credentials. A publish command
        // supplies its own one-shot helper variables through `options.env`.
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "true",
          ...options.env,
        },
      })) {
        const data = (chunk as ExecChunk).data;
        if (chunk.stream === "stderr") stderr += data;
        else stdout += data;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed? ?out/i.test(message)) {
        throw new GitError(
          "timeout",
          `git command timed out after ${options.timeoutMs ?? NORMAL_TIMEOUT_MS}ms.`,
        );
      }
      throw error;
    }

    let code = 0;
    const marker = new RegExp(`\\n?${EXIT_MARKER}(\\d+)\\s*$`);
    const stdoutMatch = marker.exec(stdout);
    if (stdoutMatch) {
      code = Number.parseInt(stdoutMatch[1], 10) || 0;
      stdout = stdout.slice(0, stdoutMatch.index);
    } else {
      const stderrMatch = marker.exec(stderr);
      if (stderrMatch) {
        code = Number.parseInt(stderrMatch[1], 10) || 0;
        stderr = stderr.slice(0, stderrMatch.index);
      } else {
        const boxMarker = /\[buildx: command exited with code (\d+)\]\s*$/.exec(stderr);
        if (boxMarker) {
          code = Number.parseInt(boxMarker[1], 10) || 0;
          stderr = stderr.slice(0, boxMarker.index);
        }
      }
    }

    return { code, stdout, stderr };
  }
}

function parseNameStatus(raw: string): NameStatusEntry[] {
  const tokens = raw.split("\0").filter(Boolean);
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    entries.push({ status: tokens[index].charAt(0), path: tokens[index + 1] });
  }
  return entries;
}

function parseNumstat(raw: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const entry of raw.split("\0")) {
    if (!entry.trim()) continue;
    const [add, del] = entry.split("\t");
    additions += Number.parseInt(add ?? "0", 10) || 0;
    deletions += Number.parseInt(del ?? "0", 10) || 0;
  }
  return { additions, deletions };
}

function describe(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text ? capOutput(text, 2_000).text : `exit code ${result.code}`;
}

function proposeTitle(head: string, commits: GitCommitSummary[]): string {
  if (commits.length === 1 && commits[0].subject) return commits[0].subject;
  return titleFromBranch(head);
}

function buildDescription(input: {
  base: string;
  head: string;
  changes: PreparedChanges;
  pushRequired: boolean;
  remoteRef: string | null;
  unpushedCommits: number;
}): string {
  const { base, head, changes, pushRequired, remoteRef, unpushedCommits } = input;
  const lines: string[] = [
    "## Local draft only",
    "",
    "This is a local draft. Nothing was pushed and no remote pull request was created.",
    "",
    "### Changes",
    "",
    `Range: \`${base}..${head}\``,
    `${changes.commits.length} commit(s), ${changes.files.length} file(s) changed, +${changes.additions} −${changes.deletions}.`,
    "",
    "### Commits",
    "",
  ];

  if (changes.commits.length === 0) {
    lines.push("- No commits between the selected refs.");
  } else {
    for (const commit of changes.commits) {
      lines.push(`- ${commit.subject} (${commit.hash.slice(0, 7)})`);
    }
    if (changes.commitsTruncated) {
      lines.push(`- … more commits omitted (limit ${COMMIT_LIMIT}).`);
    }
  }

  lines.push("", "### Files", "");
  if (changes.files.length === 0) {
    lines.push("- No changed files.");
  } else {
    for (const file of changes.files) {
      lines.push(`- ${file.path} (${humanizeStatus(file.status)})`);
    }
    if (changes.filesTruncated) {
      lines.push(`- … more files omitted (limit ${FILE_LIMIT}).`);
    }
  }

  lines.push("", "### Push status", "");
  if (pushRequired) {
    lines.push(
      remoteRef
        ? `- ${head} is ${unpushedCommits} commit(s) ahead of ${remoteRef}; push before opening a pull request.`
        : `- ${head} has no remote-tracking reference; push before opening a pull request.`,
    );
  } else {
    lines.push(`- ${head} is up to date with ${remoteRef}.`);
  }
  lines.push(
    "",
    "No push was performed, no forge API was called, and no remote pull request exists.",
  );

  return lines.join("\n");
}
