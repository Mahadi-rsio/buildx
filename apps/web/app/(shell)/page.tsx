"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Loader2 } from "lucide-react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { PanelSplit } from "@/components/shell/panel-split";
import { useShell, useShellMeta } from "@/components/shell/shell-context";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useCreateRun } from "@/hooks/use-create-run";
import { useRuns } from "@/hooks/use-runs";
import { useSkills } from "@/hooks/use-skills";
import { newConversationId } from "@/lib/conversation-id";
import { enqueueConversationEvent } from "@/lib/conversation-sync";
import { formatAgo } from "@/lib/format";
import { WorkspaceManager, type WorkspaceOption } from "@/components/workspaces/workspace-manager";
import { WorkspaceManager, type WorkspaceOption } from "@/components/workspaces/workspace-manager";

const RECENT_SESSIONS = 8;
const REPOSITORY_KEY = "buildx.selectedRepository";

interface GitHubRepository {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

type GitHubState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      connected: boolean;
      configured: boolean;
      installUrl: string | null;
      accountLogin: string | null;
      repositories: GitHubRepository[];
      message?: string;
    };

export default function NewChatPage() {
  useShellMeta({ status: "idle" });

  const { createRun, submitting, error } = useCreateRun();
  const { skills, loading: skillsLoading } = useSkills();
  const { runs, loading: runsLoading } = useRuns();
  const { modelOverride, setModelOverride, contextWindowTokens } = useShell();
  const [workspace, setWorkspace] = useState<WorkspaceOption | null>(null);
  const [draft, setDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [repository, setRepository] = useState("");
  const [github, setGithub] = useState<GitHubState>({ kind: "loading" });
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const sendInFlightRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/github/repositories", {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          connected?: boolean;
          configured?: boolean;
          installUrl?: string | null;
          account?: { login?: string | null };
          repositories?: GitHubRepository[];
          message?: string;
        };
        if (!alive) return;
        if (!res.ok) {
          setGithub({
            kind: "error",
            message: data.message ?? "Could not load GitHub repositories.",
          });
          return;
        }
        setGithub({
          kind: "ready",
          connected: Boolean(data.connected),
          configured: Boolean(data.configured),
          installUrl: data.installUrl ?? null,
          accountLogin: data.account?.login ?? null,
          repositories: Array.isArray(data.repositories)
            ? data.repositories
            : [],
        });
      } catch {
        if (alive) {
          setGithub({
            kind: "error",
            message: "Could not reach the GitHub repository endpoint.",
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const stored = window.localStorage.getItem(REPOSITORY_KEY) ?? "";
      await Promise.resolve();
      if (!alive || !stored) return;
      setRepository((current) => current || stored);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const recent = useMemo(() => runs.slice(0, RECENT_SESSIONS), [runs]);
  const repositories =
    github.kind === "ready" ? github.repositories : [];
  const needsRepository = github.kind === "ready" && repositories.length > 0;

  function chooseRepository(value: string) {
    setRepository(value);
    try {
      window.localStorage.setItem(REPOSITORY_KEY, value);
    } catch {
      // Selection still applies to this session.
    }
  }

  async function send() {
    const task = draft.trim();
    if (!workspace || workspace.status !== "ready" || task.length === 0 || submitting || sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    const conversationId = conversationIdRef.current ?? newConversationId();
    conversationIdRef.current = conversationId;
    const clientMessageId = crypto.randomUUID();
    const skillsForTurn =
      selectedSkills.length > 0 ? selectedSkills : undefined;
    const repositoryForTurn = repository || undefined;

    setPendingTask(task);
    setDraft("");
    setSelectedSkills([]);
    enqueueConversationEvent({
      id: clientMessageId,
      conversationId,
      seq: Date.now(),
      role: "user",
      content: task,
      kind: "message",
      createdAt: Date.now(),
    });

    try {
      const created = await createRun({
        task,
        workspaceId: workspace.id,
        model: modelOverride.trim() || undefined,
        contextWindow: contextWindowTokens,
        skillNames: skillsForTurn,
        conversationId,
        repository: repositoryForTurn,
        idempotencyKey: clientMessageId,
        clientMessageId,
      });
      if (!created) {
        setPendingTask(null);
        setDraft(task);
        if (skillsForTurn) setSelectedSkills(skillsForTurn);
      }
    } finally {
      sendInFlightRef.current = false;
    }
  }

  return (
    <PanelSplit workspace={null}>
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
            <WorkspaceManager selectedId={workspace?.id ?? null} onSelect={setWorkspace} />
            {workspace ? (
            <>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Start a session
            </h1>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Pick a repository, describe the task, and the agent will work in
              your persistent workspace.
            </p>

            <div className="mt-6 rounded-xl border border-border/70 bg-[var(--surface)]/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <GitBranch className="size-4 shrink-0 text-[var(--text-muted)]" />
                {github.kind === "loading" ? (
                  <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Checking GitHub connection…
                  </span>
                ) : github.kind === "error" ? (
                  <span className="text-xs text-muted-foreground">
                    {github.message}
                  </span>
                ) : github.connected ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {github.accountLogin
                        ? `Connected as @${github.accountLogin}`
                        : "GitHub connected"}
                    </span>
                    {needsRepository ? (
                      <select
                        value={repository}
                        onChange={(event) =>
                          chooseRepository(event.target.value)
                        }
                        aria-label="Repository"
                        className="ml-auto h-8 max-w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                      >
                        <option value="">No repository (workspace only)</option>
                        {repositories.map((repo) => (
                          <option key={repo.fullName} value={repo.fullName}>
                            {repo.fullName}
                            {repo.private ? " (private)" : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="ml-auto text-2xs text-[var(--text-faint)]">
                        No repositories available to this installation.
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {github.configured
                        ? "Connect GitHub to choose a repository."
                        : "GitHub App credentials are not configured on this server."}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      render={
                        <a href="/api/github/connect?returnTo=/" />
                      }
                      nativeButton={false}
                    >
                      Connect GitHub
                    </Button>
                  </>
                )}
              </div>
              {github.kind === "ready" && github.installUrl && !github.connected ? (
                <a
                  href={github.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-2xs text-muted-foreground underline underline-offset-2"
                >
                  Install the GitHub App
                </a>
              ) : null}
            </div>

            {pendingTask ? (
              <div className="mt-6 flex justify-end">
                <div className="max-w-[85%] rounded-[10px] border border-border/60 bg-[var(--surface)] px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6] text-[var(--text)]">
                    {pendingTask}
                  </p>
                  <span className="mt-1 block text-2xs uppercase tracking-wide text-[var(--text-faint)]">
                    Starting…
                  </span>
                </div>
              </div>
            ) : null}

            <section className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recent sessions
                </h2>
                {runs.length > RECENT_SESSIONS ? (
                  <span className="font-mono text-2xs text-muted-foreground/70">
                    latest {RECENT_SESSIONS}
                  </span>
                ) : null}
              </div>

              {runsLoading ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Loading sessions…
                </p>
              ) : recent.length === 0 ? (
                <div className="mt-2 rounded-xl border border-dashed border-border/70 px-3 py-5 text-center">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    No sessions yet. Describe your first task below to start one.
                  </p>
                </div>
              ) : (
                <ul className="mt-2 space-y-1">
                  {recent.map((session) => (
                    <li key={session.id}>
                      <Link
                        href={`/runs/${session.id}`}
                        className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted/40"
                      >
                        <StatusBadge status={session.status} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
                          {session.task}
                        </span>
                        <span className="hidden shrink-0 font-mono text-2xs text-muted-foreground sm:inline">
                          {session.repository ?? "workspace"}
                        </span>
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
                          {formatAgo(session.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            </>
            ) : null}
          </div>
        </div>

        {workspace ? <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          model={modelOverride}
          onModelChange={setModelOverride}
          skills={skills ?? []}
          skillsLoading={skillsLoading}
          selectedSkills={selectedSkills}
          onSelectedSkillsChange={setSelectedSkills}
          submitting={submitting}
          error={error}
          hint="Start session creates a run in your persistent workspace"
          placeholder="Describe a coding task…"
        /> : null}
      </div>
    </PanelSplit>
  );
}
