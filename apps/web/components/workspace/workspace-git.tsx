"use client";

import { useEffect, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  CloudCog,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  Save,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  GitRepositoryInfo,
  GitRepositorySummary,
  PullRequestDraft,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface GitHubRepositoriesResponse {
  connected: boolean;
  configured: boolean;
  installUrl: string | null;
  account?: {
    login: string;
    name: string | null;
    avatarUrl: string | null;
    installationId: string;
  } | null;
  repositories?: Array<{
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
  }>;
  error?: string;
  message?: string;
}

interface GitListResponse {
  ready: boolean;
  repositories: GitRepositoryInfo[];
  repo: GitRepositorySummary | null;
}

interface ApiFailure {
  error?: string;
  message?: string;
  changedFiles?: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readFailure(response: Response): Promise<ApiFailure> {
  try {
    return (await response.json()) as ApiFailure;
  } catch {
    return { message: `Request failed (${response.status}).` };
  }
}

function Failure({ failure }: { failure: ApiFailure | null }) {
  if (!failure) return null;
  return (
    <Alert variant="destructive" className="px-2 py-1.5">
      <AlertDescription className="text-[11px] leading-relaxed">
        {failure.message ?? failure.error ?? "The Git request failed."}
        {failure.changedFiles?.length ? (
          <span className="mt-1 block font-mono text-[10px] opacity-80">
            {failure.changedFiles.slice(0, 12).join(", ")}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-1.5 border-b border-border px-2 py-2 last:border-b-0">
      <h3 className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function BranchOptions({
  repo,
  value,
  onChange,
  includeCurrent = false,
}: {
  repo: GitRepositorySummary;
  value: string;
  onChange: (value: string) => void;
  includeCurrent?: boolean;
}) {
  const options = Array.from(
    new Set([
      ...(includeCurrent && repo.currentBranch ? [repo.currentBranch] : []),
      ...repo.branches.local,
      ...repo.branches.remote,
    ]),
  );
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      aria-label="Branch"
    >
      {value === "" ? <option value="">select branch</option> : null}
      {options.map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  );
}

export function WorkspaceGit({ workspaceId }: { workspaceId: string }) {
  const [repositories, setRepositories] = useState<GitRepositoryInfo[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const [repoPath, setRepoPath] = useState("");
  const [repo, setRepo] = useState<GitRepositorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);

  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDir, setCloneDir] = useState("");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");

  const [prBase, setPrBase] = useState("");
  const [prHead, setPrHead] = useState("");
  const [draft, setDraft] = useState<PullRequestDraft | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const [prDescription, setPrDescription] = useState("");
  const [draftError, setDraftError] = useState<ApiFailure | null>(null);

  const [github, setGithub] = useState<GitHubRepositoriesResponse | null>(null);
  const [githubLoading, setGithubLoading] = useState(true);
  const [githubRefreshing, setGithubRefreshing] = useState(false);
  const [githubNotice, setGithubNotice] = useState<
    { ok: boolean; message: string } | null
  >(null);

  async function loadGitHub() {
    try {
      const response = await fetch("/api/github/repositories", {
        cache: "no-store",
      });
      if (!response.ok) {
        const failure = await readFailure(response);
        setGithub({
          connected: false,
          configured: false,
          installUrl: null,
          error: failure.error,
          message: failure.message,
        });
        return;
      }
      setGithub((await response.json()) as GitHubRepositoriesResponse);
    } catch (caught) {
      setGithub({
        connected: false,
        configured: false,
        installUrl: null,
        message: message(caught),
      });
    } finally {
      setGithubLoading(false);
    }
  }

  function refreshGitHub() {
    setGithubRefreshing(true);
    void loadGitHub().finally(() => setGithubRefreshing(false));
  }

  function connectGitHub() {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/github/connect?returnTo=${encodeURIComponent(returnTo)}`;
  }

  async function loadRepositories(select?: string) {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/git`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        setError(await readFailure(response));
        return;
      }
      const data = (await response.json()) as GitListResponse;
      setReady(data.ready);
      setRepositories(data.repositories);
      setRepoPath((current) => {
        const next = select ?? (current || data.repositories[0]?.path || "");
        return next;
      });
    } catch (caught) {
      setError({ message: message(caught) });
    } finally {
      setLoading(false);
    }
  }

  async function loadRepository(path: string) {
    if (!path) {
      setRepo(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/git?path=${encodeURIComponent(path)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        setError(await readFailure(response));
        setRepo(null);
        return;
      }
      const data = (await response.json()) as GitListResponse;
      setRepo(data.repo);
      if (data.repo) {
        setBaseBranch((current) => current || data.repo?.currentBranch || "");
        setPrHead((current) => current || data.repo?.currentBranch || "");
        setPrBase((current) => current || data.repo?.branches.local[0] || "");
      }
    } catch (caught) {
      setError({ message: message(caught) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      await loadRepositories();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      await loadRepository(repoPath);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, workspaceId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      await loadGitHub();
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      const params = new URLSearchParams(window.location.search);
      const githubResult = params.get("github");
      if (githubResult === "connected") {
        setGithubNotice({ ok: true, message: "GitHub connected." });
      } else if (githubResult === "error") {
        setGithubNotice({
          ok: false,
          message: params.get("message") ?? "GitHub connection failed.",
        });
      } else {
        return;
      }
      params.delete("github");
      params.delete("message");
      const suffix = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${suffix ? `?${suffix}` : ""}`,
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive || !repoPath || !prBase || !prHead) {
        if (alive) setDraft(null);
        return;
      }
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/git/pr?path=${encodeURIComponent(repoPath)}&base=${encodeURIComponent(prBase)}&head=${encodeURIComponent(prHead)}`,
          { cache: "no-store" },
        );
        if (response.status === 404) {
          if (alive) {
            setDraft(null);
            setDraftError(null);
          }
          return;
        }
        if (!response.ok) {
          if (alive) setDraftError(await readFailure(response));
          return;
        }
        const data = (await response.json()) as { draft: PullRequestDraft };
        if (!alive) return;
        setDraft(data.draft);
        setDraftError(null);
        setPrTitle(data.draft.title);
        setPrDescription(data.draft.description);
      } catch (caught) {
        if (alive) setDraftError({ message: message(caught) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, repoPath, prBase, prHead]);

  async function post(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/git`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        setError(await readFailure(response));
        return null;
      }
      return (await response.json()) as Record<string, unknown>;
    } catch (caught) {
      setError({ message: message(caught) });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function clone() {
    const data = await post(
      {
        action: "clone",
        url: cloneUrl.trim(),
        ...(cloneDir.trim() ? { directory: cloneDir.trim() } : {}),
      },
      "clone",
    );
    if (!data) return;
    const repoPathValue = data.repoPath;
    if (typeof repoPathValue === "string") {
      setCloneUrl("");
      setCloneDir("");
      setRepoPath(repoPathValue);
      await loadRepositories(repoPathValue);
    }
  }

  async function createBranch() {
    if (!repoPath) return;
    const data = await post(
      {
        action: "create_branch",
        path: repoPath,
        branch: branchName.trim(),
        base: baseBranch,
      },
      "branch",
    );
    if (!data) return;
    const next = data.repo as GitRepositorySummary | undefined;
    if (next) {
      setRepo(next);
      setBranchName("");
      setPrHead(next.currentBranch ?? "");
    }
  }

  async function switchBranch(branch: string) {
    if (!repoPath) return;
    const data = await post(
      { action: "switch_branch", path: repoPath, branch },
      "switch",
    );
    if (!data) return;
    const next = data.repo as GitRepositorySummary | undefined;
    if (next) {
      setRepo(next);
      setPrHead(next.currentBranch ?? "");
      setSelectedFiles([]);
    }
  }

  async function stageCommit() {
    if (!repoPath || selectedFiles.length === 0) return;
    const data = await post(
      {
        action: "stage_commit",
        path: repoPath,
        files: selectedFiles,
        message: commitMessage.trim(),
      },
      "commit",
    );
    if (!data) return;
    const next = data.repo as GitRepositorySummary | undefined;
    if (next) {
      setRepo(next);
      setSelectedFiles([]);
      setCommitMessage("");
      setPrHead(next.currentBranch ?? "");
    }
  }

  async function preparePr() {
    if (!repoPath) return;
    const data = await post(
      {
        action: "prepare_pr",
        path: repoPath,
        base: prBase,
        head: prHead,
      },
      "prepare-pr",
    );
    if (!data) return;
    const next = data.draft as PullRequestDraft | undefined;
    if (next) {
      setDraft(next);
      setPrTitle(next.title);
      setPrDescription(next.description);
      setDraftError(null);
    }
  }

  async function saveDraft() {
    if (!repoPath) return;
    setBusy("save-pr");
    setDraftError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/git/pr`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: repoPath,
            base: prBase,
            head: prHead,
            title: prTitle.trim(),
            description: prDescription.trim(),
          }),
        },
      );
      if (!response.ok) {
        setDraftError(await readFailure(response));
        return;
      }
      const data = (await response.json()) as { draft: PullRequestDraft };
      setDraft(data.draft);
    } catch (caught) {
      setDraftError({ message: message(caught) });
    } finally {
      setBusy(null);
    }
  }

  function toggleFile(path: string) {
    setSelectedFiles((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path],
    );
  }

  const branches = repo
    ? Array.from(new Set([...repo.branches.local, ...repo.branches.remote]))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-sidebar/60 px-2 py-1.5">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <select
          value={repoPath}
          onChange={(event) => setRepoPath(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 font-mono text-[11px] outline-none focus-visible:border-ring"
          aria-label="Repository"
        >
          <option value="">
            {repositories.length === 0 ? "no repositories" : "select repository"}
          </option>
          {repositories.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.path}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh repository"
          title="Refresh"
          onClick={() => {
            void loadRepositories(repoPath);
            if (repoPath) void loadRepository(repoPath);
          }}
        >
          <RefreshCw className="size-3" />
        </Button>
        {busy ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
      </div>

      {error ? (
        <div className="px-2 pt-2">
          <Failure failure={error} />
        </div>
      ) : null}

      {ready === false ? (
        <p className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          This workspace has no box yet. Start a run before using Git.
        </p>
      ) : null}

      <Section title="GitHub" icon={<CloudCog className="size-3" />}>
        {githubNotice ? (
          <Alert
            variant={githubNotice.ok ? "default" : "destructive"}
            className="px-2 py-1.5"
          >
            <AlertDescription className="text-[11px] leading-relaxed">
              {githubNotice.message}
            </AlertDescription>
          </Alert>
        ) : null}

        {githubLoading && !github ? (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Checking GitHub…
          </p>
        ) : !github ? (
          <p className="text-[11px] text-muted-foreground">
            GitHub status unavailable.
          </p>
        ) : github.connected ? (
          <>
            <div className="flex items-center gap-1.5">
              <Avatar className="size-6">
                {github.account?.avatarUrl ? (
                  <AvatarImage
                    src={github.account.avatarUrl}
                    alt={github.account?.login ?? "GitHub"}
                  />
                ) : null}
                <AvatarFallback className="size-6 text-[10px]">
                  {github.account?.login?.slice(0, 2).toUpperCase() ?? "GH"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px]">
                  {github.account?.name || github.account?.login}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  @{github.account?.login}
                </p>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh GitHub connection"
                title="Refresh"
                disabled={githubRefreshing}
                onClick={refreshGitHub}
              >
                <RefreshCw
                  className={cn("size-3", githubRefreshing && "animate-spin")}
                />
              </Button>
            </div>
            {github.repositories && github.repositories.length > 0 ? (
              <select
                value={github.repositories[0].fullName}
                onChange={(event) => {
                  const fullName = event.target.value;
                  const repository = github.repositories?.find(
                    (entry) => entry.fullName === fullName,
                  );
                  if (repository && !cloneUrl.trim()) {
                    setCloneUrl(`https://github.com/${repository.fullName}.git`);
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                aria-label="Installation repository"
              >
                {github.repositories.map((repository) => (
                  <option key={repository.fullName} value={repository.fullName}>
                    {repository.fullName}
                    {repository.private ? " · private" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                No repositories on this installation yet. Grant repository access
                from the GitHub App page, then refresh.
              </p>
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Used by the publish tool and private clones. The connection stays
              server-side; no token is stored in this browser.
            </p>
          </>
        ) : (
          <>
            {github.error || github.message ? (
              <Alert variant="destructive" className="px-2 py-1.5">
                <AlertDescription className="text-[11px] leading-relaxed">
                  {github.message ?? "The GitHub connection is unavailable."}
                </AlertDescription>
              </Alert>
            ) : null}
            {github.configured ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={connectGitHub}
              >
                <LogIn className="size-3" />
                Connect GitHub
              </Button>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                GitHub is not configured. Set GITHUB_APP_ID,
                GITHUB_APP_PRIVATE_KEY and GITHUB_APP_SLUG, then reload.
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Clone a repository" icon={<GitBranch className="size-3" />}>
        <Input
          value={cloneUrl}
          onChange={(event) => setCloneUrl(event.target.value)}
          placeholder="https://github.com/owner/repo.git"
          spellCheck={false}
          className="h-7 font-mono text-[11px]"
          aria-label="Repository URL"
        />
        <div className="flex items-center gap-1.5">
          <Input
            value={cloneDir}
            onChange={(event) => setCloneDir(event.target.value)}
            placeholder="directory (optional)"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            aria-label="Clone directory"
          />
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!cloneUrl.trim() || busy !== null}
            onClick={() => void clone()}
          >
            <Plus className="size-3" />
            Clone
          </Button>
        </div>
      </Section>

      {repo ? (
        <>
          <Section title="Branch" icon={<ArrowRightLeft className="size-3" />}>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="font-mono text-[10px]">
                {repo.currentBranch ?? "detached"}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                {repo.status.clean
                  ? "clean"
                  : `${repo.status.changedFiles.length} changed`}
                {repo.status.upstream ? ` · ${repo.status.upstream}` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {branches.slice(0, 12).map((branch) => (
                <button
                  key={branch}
                  type="button"
                  onClick={() => void switchBranch(branch)}
                  disabled={busy !== null || branch === repo.currentBranch}
                  className={cn(
                    "max-w-full truncate rounded border border-border px-1.5 py-0.5 font-mono text-[10px] transition hover:bg-muted/60 disabled:opacity-40",
                    branch === repo.currentBranch && "bg-muted/60",
                  )}
                >
                  {branch}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="feature/my-change"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                aria-label="New branch name"
              />
              <BranchOptions
                repo={repo}
                value={baseBranch}
                onChange={setBaseBranch}
                includeCurrent
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!branchName.trim() || !baseBranch || busy !== null}
                onClick={() => void createBranch()}
              >
                <GitBranch className="size-3" />
                Create
              </Button>
            </div>
          </Section>

          <Section title="Changes" icon={<GitCommitHorizontal className="size-3" />}>
            {repo.status.changedFiles.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No working-tree changes.</p>
            ) : (
              <div className="grid gap-0.5">
                {repo.status.changedFiles.map((file) => {
                  const selected = selectedFiles.includes(file.path);
                  return (
                    <label
                      key={`${file.path}:${file.staged}`}
                      className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleFile(file.path)}
                        className="size-3 accent-[var(--primary)]"
                      />
                      <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">
                        {file.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                        {file.path}
                      </span>
                      {file.staged ? (
                        <Check className="size-3 shrink-0 text-emerald-500" />
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
            <Input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="commit message"
              className="h-7 text-[11px]"
              aria-label="Commit message"
            />
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                disabled={
                  selectedFiles.length === 0 ||
                  !commitMessage.trim() ||
                  busy !== null
                }
                onClick={() => void stageCommit()}
              >
                <GitCommitHorizontal className="size-3" />
                Stage &amp; commit
              </Button>
              <span className="text-[10px] text-muted-foreground">
                local commit only
              </span>
            </div>
            {repo.diff ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-[var(--surface)] p-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                {repo.diff}
                {repo.diffTruncated ? "\n[diff truncated]" : ""}
              </pre>
            ) : null}
          </Section>

          <Section title="Local pull request" icon={<GitPullRequest className="size-3" />}>
            <div className="flex items-center gap-1.5">
              <BranchOptions repo={repo} value={prBase} onChange={setPrBase} />
              <span className="text-[10px] text-muted-foreground">←</span>
              <BranchOptions
                repo={repo}
                value={prHead}
                onChange={setPrHead}
                includeCurrent
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!prBase || !prHead || busy !== null}
                onClick={() => void preparePr()}
              >
                <GitPullRequest className="size-3" />
                Generate draft
              </Button>
              {draft ? (
                <Badge
                  variant={draft.status === "push_required" ? "destructive" : "secondary"}
                  className="font-mono text-[10px] uppercase"
                >
                  {draft.status === "push_required" ? "push required" : "local draft"}
                </Badge>
              ) : null}
            </div>
            {draft ? (
              <>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {draft.notes}
                </p>
                <Input
                  value={prTitle}
                  onChange={(event) => setPrTitle(event.target.value)}
                  placeholder="PR title"
                  className="h-7 text-[11px]"
                  aria-label="Pull request title"
                />
                <Textarea
                  value={prDescription}
                  onChange={(event) => setPrDescription(event.target.value)}
                  placeholder="PR description"
                  className="min-h-24 text-[11px]"
                  aria-label="Pull request description"
                />
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="xs"
                    disabled={!prTitle.trim() || !prDescription.trim() || busy !== null}
                    onClick={() => void saveDraft()}
                  >
                    <Save className="size-3" />
                    Save draft
                  </Button>
                  <span className="text-[10px] text-muted-foreground">
                    local only · nothing is pushed
                  </span>
                </div>
                {draftError ? <Failure failure={draftError} /> : null}
                {draft.changedFiles.length > 0 ? (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {draft.changedFiles.length} changed file
                    {draft.changedFiles.length === 1 ? "" : "s"} ·{" "}
                    {draft.unpushedCommits} unpushed commit
                    {draft.unpushedCommits === 1 ? "" : "s"}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                Generates a local title/description from real commits and diffs.
                No remote PR is created.
              </p>
            )}
          </Section>
        </>
      ) : loading ? (
        <p className="px-3 py-3 text-[11px] text-muted-foreground">
          Loading repositories…
        </p>
      ) : ready !== false ? (
        <p className="px-3 py-3 text-[11px] text-muted-foreground">
          No Git repository yet. Clone a public HTTPS repository to start.
        </p>
      ) : null}
    </div>
  );
}
