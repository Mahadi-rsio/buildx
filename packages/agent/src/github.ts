import { WorkspaceGit, type Sandbox } from "@buildx/sandbox";
import { tool } from "ai";
import { z } from "zod";

/**
 * GitHub publishing tool. The web app injects credentials per call; the model
 * never sees a token. Tokens are passed to git only through the process
 * environment, and to the REST API only through the Authorization header.
 */

export interface GitHubToolAuth {
  token: string;
  /** HTTPS username: the login for user tokens, `x-access-token` for Apps. */
  username: string;
  login: string;
  installationId?: string;
}

export interface GitHubToolsOptions {
  getAuth: (owner?: string) => Promise<GitHubToolAuth>;
  /** Test seam / GitHub Enterprise API origin. */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface GitHubRepository {
  name: string;
  full_name: string;
  default_branch: string;
  clone_url: string;
  html_url: string;
  private: boolean;
  owner: { login: string };
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  state: string;
  base: { ref: string };
  head: { ref: string };
}

export class GitHubPublishError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubPublishError";
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Parse a GitHub HTTPS or SSH remote into its owner/repository. */
export function parseGitHubRemote(
  value: string,
): { owner: string; repo: string } | null {
  const raw = value.trim();
  if (!raw) return null;
  const ssh = raw.match(/^(?:git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) {
    const repo = ssh[2].replace(/\.git$/i, "");
    if (OWNER_PATTERN.test(ssh[1]) && REPO_PATTERN.test(repo)) {
      return { owner: ssh[1], repo };
    }
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = decodeURIComponent(segments[0]);
    const repo = decodeURIComponent(segments[1]).replace(/\.git$/i, "");
    if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/** Resolve `owner/name` (or just `name`) for a repository to create. */
export function parseRepositoryInput(
  value: string | undefined,
  fallbackOwner: string,
): { owner: string; repo: string } | null {
  const raw = value?.trim();
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length > 2) return null;
  const owner = parts.length === 2 ? parts[0] : fallbackOwner;
  const repo = parts.length === 2 ? parts[1] : parts[0];
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
}

function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "update";
}

function newHeadBranch(title: string): string {
  return `buildx/${branchSlug(title)}-${Date.now().toString(36)}`;
}

class GitHubPublishClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly auth: GitHubToolAuth,
    options: GitHubToolsOptions,
  ) {
    this.baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.auth.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `GitHub API ${response.status}`;
      let body: unknown;
      try {
        body = JSON.parse(text);
        const candidate = body as { message?: string; errors?: unknown };
        if (candidate.message) {
          message = candidate.message;
          if (candidate.errors) {
            message += ` (${JSON.stringify(candidate.errors)})`;
          }
        }
      } catch {
        // Keep the status-only message.
      }
      throw new GitHubPublishError(
        message,
        response.status,
      );
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
  }

  async createRepository(input: {
    owner: string;
    repo: string;
    private: boolean;
    description?: string;
  }): Promise<GitHubRepository> {
    let organization = false;
    if (input.owner.toLowerCase() !== this.auth.login.toLowerCase()) {
      const account = await this.request<{ type?: string }>(
        `/users/${encodeURIComponent(input.owner)}`,
      );
      organization = account.type === "Organization";
      if (!organization) {
        throw new Error(
          `Repositories can only be created under your own account or an organization you administer, not ${input.owner}.`,
        );
      }
    }
    return this.request<GitHubRepository>(
      organization
        ? `/orgs/${encodeURIComponent(input.owner)}/repos`
        : "/user/repos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.repo,
          private: input.private,
          auto_init: true,
          ...(input.description ? { description: input.description } : {}),
        }),
      },
    );
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ pullRequest: GitHubPullRequest; existing: boolean }> {
    try {
      const pullRequest = await this.request<GitHubPullRequest>(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            base: input.base,
            head: `${input.owner}:${input.head}`,
            draft: input.draft,
          }),
        },
      );
      return { pullRequest, existing: false };
    } catch (error) {
      if (!(error instanceof GitHubPublishError) || error.status !== 422) {
        throw error;
      }
      const existing = await this.findOpenPullRequest(input);
      if (existing) return { pullRequest: existing, existing: true };
      throw error;
    }
  }

  private async findOpenPullRequest(input: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<GitHubPullRequest | null> {
    const query = new URLSearchParams({
      state: "open",
      base: input.base,
      head: `${input.owner}:${input.head}`,
    });
    const pulls = await this.request<GitHubPullRequest[]>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls?${query}`,
    );
    return pulls[0] ?? null;
  }
}

function isSshRemote(url: string): boolean {
  return /^(?:git@|ssh:\/\/)/i.test(url);
}

/**
 * Build the `github_create_pull_request` tool. It initializes a repository when
 * needed, commits the workspace, pushes a branch, and opens (or reuses) a pull
 * request. Repository creation is opt-in via `createRepository`.
 */
export function buildGitHubTools(
  sandbox: Sandbox,
  options: GitHubToolsOptions,
) {
  const git = new WorkspaceGit(sandbox);

  return {
    github_create_pull_request: tool({
      description:
        "Publish workspace changes to GitHub and open a pull request. Commits all " +
        "workspace changes on a branch, pushes it with the connected GitHub account, " +
        "and creates (or reuses) the PR. Use ONLY when the user explicitly asks to " +
        "publish, push, or open a pull request. If the workspace has no GitHub remote, " +
        "pass `repository` and set `createRepository` to true. Requires GitHub to be " +
        "connected in Settings; never ask for or handle a token yourself.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("Pull request title"),
        body: z
          .string()
          .max(10_000)
          .optional()
          .describe("Pull request description (Markdown)"),
        repoPath: z
          .string()
          .optional()
          .describe("Workspace-relative repository path (default: workspace root)"),
        base: z
          .string()
          .optional()
          .describe("Base branch; defaults to the repository's default branch"),
        head: z
          .string()
          .optional()
          .describe("Head branch to push; defaults to a new buildx/<slug> branch"),
        commitMessage: z
          .string()
          .max(500)
          .optional()
          .describe("Commit message for workspace changes"),
        repository: z
          .string()
          .optional()
          .describe("Repository to create/use when there is no remote: owner/name"),
        createRepository: z
          .boolean()
          .optional()
          .describe("Create the GitHub repository when none exists (default false)"),
        private: z
          .boolean()
          .optional()
          .describe("Create a private repository (default true)"),
        draft: z
          .boolean()
          .optional()
          .describe("Open the pull request as a draft (default false)"),
      }),
      execute: async (input, toolOptions) => {
        if (toolOptions?.abortSignal?.aborted) {
          throw new Error("Tool execution aborted: run cancelled");
        }

        const repoPath = input.repoPath?.trim() || ".";
        const isRepo = await git.isRepository(repoPath);
        const summary = isRepo ? await git.getRepository(repoPath) : null;

        let target = summary?.remoteUrl
          ? parseGitHubRemote(summary.remoteUrl)
          : null;
        if (summary?.remoteUrl && !target) {
          throw new Error(
            `The remote ${summary.remoteUrl} is not a GitHub repository. Set an HTTPS GitHub remote first.`,
          );
        }

        let auth = await options.getAuth(target?.owner);
        const requested = parseRepositoryInput(input.repository, auth.login);
        if (!target && requested) target = requested;
        if (!target && !summary?.remoteUrl) {
          throw new Error(
            "This workspace has no GitHub remote. Pass `repository` (owner/name or name) and set `createRepository` to true.",
          );
        }
        if (!target) {
          throw new Error("Could not determine the target GitHub repository.");
        }
        if (target.owner.toLowerCase() !== auth.login.toLowerCase()) {
          auth = await options.getAuth(target.owner);
        }
        const client = new GitHubPublishClient(auth, options);
        const owner = target.owner;
        const repo = target.repo;

        let createdRepository = false;
        let remote = summary?.remoteUrl ?? "";
        let base = input.base?.trim();

        if (!summary?.remoteUrl) {
          if (!input.createRepository) {
            throw new Error(
              "This workspace has no GitHub remote. Set `createRepository` to true to create one.",
            );
          }
          let created: GitHubRepository;
          try {
            created = await client.createRepository({
              owner,
              repo,
              private: input.private ?? true,
            });
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            throw new Error(
              `Could not create ${owner}/${repo}: ${detail}. The GitHub App needs ` +
                "Contents write and Administration write permissions and must be " +
                `installed on ${owner}; alternatively connect an existing repository.`,
              { cause: error },
            );
          }
          createdRepository = true;
          remote = created.clone_url;
          base = base || created.default_branch || "main";

          if (!summary) {
            const head = input.head?.trim() || newHeadBranch(input.title);
            if (head === base) {
              throw new Error("The head branch must differ from the base branch.");
            }
            await git.initialize({ path: repoPath, branch: head });
            await git.setRemote({ path: repoPath, url: remote });
            await git.fetch({ path: repoPath, remote: "origin", branch: base, auth });
            await git.stageAllAndCommit({
              path: repoPath,
              message: input.commitMessage || input.title,
            });
            await git.mergeUnrelatedOurs({ path: repoPath, ref: `origin/${base}` });
            await git.push({
              path: repoPath,
              branch: head,
              auth,
            });
            const result = await client.createPullRequest({
              owner,
              repo,
              base,
              head,
              title: input.title,
              body: input.body ?? "",
              draft: input.draft ?? false,
            });
            return pullRequestResult(result, {
              owner,
              repo,
              base,
              head,
              createdRepository,
            });
          }

          await git.setRemote({ path: repoPath, url: remote });
          await git.fetch({ path: repoPath, remote: "origin", branch: base, auth });
          // The remote was just created with `auto_init`, so its history is
          // unrelated to the existing local repository. Join it after commit.
          createdRepository = true;
        } else {
          if (!remote.startsWith("https://")) {
            const https = `https://github.com/${owner}/${repo}.git`;
            if (isSshRemote(remote)) {
              await git.setRemote({ path: repoPath, url: https });
            } else {
              throw new Error(
                `The remote ${remote} must be an HTTPS GitHub URL to use the connected account.`,
              );
            }
          }
          const metadata = await client.getRepository(owner, repo);
          base = base || metadata.default_branch || "main";
          await git.fetch({ path: repoPath, remote: "origin", branch: base, auth });
        }

        if (!base) throw new Error("Could not determine the base branch.");

        const refreshed = await git.getRepository(repoPath);
        let head =
          input.head?.trim() ||
          (refreshed.currentBranch && refreshed.currentBranch !== base
            ? refreshed.currentBranch
            : newHeadBranch(input.title));
        if (head === base) {
          if (!refreshed.status.clean || refreshed.status.unpushedCommits > 0) {
            head = newHeadBranch(input.title);
          } else {
            throw new Error("The head branch must differ from the base branch.");
          }
        }

        if (refreshed.currentBranch !== head) {
          if (refreshed.branches.local.includes(head)) {
            await git.switchBranch({ path: repoPath, branch: head });
          } else {
            // Prefer the checked-out branch when it carries local work or when
            // we are publishing a new repository, so local commits survive.
            const preferCurrent =
              createdRepository ||
              (refreshed.currentBranch !== null &&
                refreshed.currentBranch !== base) ||
              refreshed.status.unpushedCommits > 0;
            const baseRef = preferCurrent && refreshed.currentBranch
              ? refreshed.currentBranch
              : refreshed.branches.remote.includes(`origin/${base}`)
                ? `origin/${base}`
                : base;
            await git.createBranch({
              path: repoPath,
              branch: head,
              base: baseRef,
            });
          }
        }

        const beforeCommit = await git.getRepository(repoPath);
        if (!beforeCommit.status.clean) {
          await git.stageAllAndCommit({
            path: repoPath,
            message: input.commitMessage || input.title,
          });
        }
        if (createdRepository) {
          await git.mergeUnrelatedOurs({
            path: repoPath,
            ref: `origin/${base}`,
          });
        }

        await git.push({
          path: repoPath,
          branch: head,
          auth,
        });

        const result = await client.createPullRequest({
          owner,
          repo,
          base,
          head,
          title: input.title,
          body: input.body ?? "",
          draft: input.draft ?? false,
        });
        return pullRequestResult(result, {
          owner,
          repo,
          base,
          head,
          createdRepository,
        });
      },
    }),
  };
}

function pullRequestResult(
  result: {
    pullRequest: GitHubPullRequest;
    existing: boolean;
  },
  context: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    createdRepository: boolean;
  },
) {
  return {
    url: result.pullRequest.html_url,
    number: result.pullRequest.number,
    title: result.pullRequest.title,
    state: result.pullRequest.state,
    draft: result.pullRequest.draft ?? false,
    existing: result.existing,
    repository: `${context.owner}/${context.repo}`,
    base: context.base,
    head: context.head,
    createdRepository: context.createdRepository,
  };
}
