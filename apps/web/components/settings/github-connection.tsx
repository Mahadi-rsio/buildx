"use client";

import { useEffect, useState } from "react";
import { ExternalLink, GitPullRequest, Loader2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

interface GitHubStatus {
  configured: boolean;
  connected: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  installationId: string | null;
  installUrl: string | null;
  connectedAt: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: GitHubStatus; notice?: { message: string; error: boolean } };

function statusNotice(): { message: string; error: boolean } | undefined {
  const params = new URLSearchParams(window.location.search);
  if (params.get("github") === "connected") {
    return {
      message:
        "GitHub connected. The agent can now open pull requests when you ask.",
      error: false,
    };
  }
  if (params.get("github") === "error") {
    return {
      message: params.get("message") || "GitHub authorization failed. Try again.",
      error: true,
    };
  }
  return undefined;
}

export function GitHubConnection() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      const notice = statusNotice();
      try {
        const response = await fetch("/api/github/status", {
          cache: "no-store",
        });
        const status = (await response.json()) as GitHubStatus & {
          error?: string;
        };
        if (!active) return;
        if (!response.ok) {
          setState({
            kind: "error",
            message: status.error || "Could not load the GitHub connection.",
          });
          return;
        }
        setState({ kind: "ready", status, notice });
        if (notice) {
          const url = new URL(window.location.href);
          url.searchParams.delete("github");
          url.searchParams.delete("message");
          window.history.replaceState({}, "", url);
        }
      } catch {
        if (active) {
          setState({
            kind: "error",
            message: "Could not reach the GitHub connection endpoint.",
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [nonce]);

  async function disconnect() {
    setBusy(true);
    try {
      await fetch("/api/github/disconnect", { method: "POST" });
      setNonce((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Checking GitHub connection…
      </div>
    );
  }

  if (state.kind === "error") {
    return <p className="text-xs text-destructive">{state.message}</p>;
  }

  const { status, notice } = state;

  return (
    <div className="space-y-3 text-xs">
      {notice ? (
        <p
          className={
            notice.error
              ? "rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
              : "rounded-lg border border-border bg-background px-3 py-2 text-muted-foreground"
          }
        >
          {notice.message}
        </p>
      ) : null}

      {!status.configured && !status.connected ? (
        <p className="rounded-lg border border-border bg-background px-3 py-2 text-muted-foreground">
          GitHub App credentials are not configured on this server. Set
          <code className="mx-1 font-mono">GITHUB_CLIENT_ID</code> and
          <code className="mx-1 font-mono">GITHUB_CLIENT_SECRET</code>.
        </p>
      ) : null}

      {status.connected ? (
        <>
          <div className="flex items-center gap-3">
            <Avatar>
              {status.avatarUrl ? (
                <AvatarImage src={status.avatarUrl} alt={status.login ?? "GitHub"} />
              ) : null}
              <AvatarFallback>
                <GitPullRequest className="size-4" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">
                  {status.name || status.login}
                </span>
                <span className="font-mono text-muted-foreground">
                  @{status.login}
                </span>
                <Badge variant={status.installationId ? "secondary" : "outline"}>
                  {status.installationId ? "App installed" : "App not installed"}
                </Badge>
              </div>
              <p className="mt-0.5 text-muted-foreground">
                The agent can publish branches and open pull requests only when
                you explicitly ask.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!status.installationId && status.installUrl ? (
              <a
                href={status.installUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Install app
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
            <a
              href="/api/github/connect"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Reconnect
            </a>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/api/github/connect"
            className={buttonVariants({ variant: "default", size: "sm" })}
          >
            <GitPullRequest className="size-3.5" />
            Connect GitHub
          </a>
          {status.installUrl ? (
            <a
              href={status.installUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Install app
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}
