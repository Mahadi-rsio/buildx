"use client";

import Link from "next/link";
import { ArrowUpRight, GitPullRequest, MonitorCog, Palette, UserRound } from "lucide-react";
import { GitHubConnection } from "@/components/settings/github-connection";
import { ThemeSwitch } from "@/components/shell/theme-switch";
import { useShellMeta } from "@/components/shell/shell-context";
import { useUser } from "@/hooks/use-user";
import { formatTaka, readCreditBalance } from "@/lib/credits";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface/50 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  useShellMeta({ status: "idle" });
  const { user } = useUser();
  const mounted = useMounted();
  const balance = mounted ? readCreditBalance() : 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-2xl px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-10">
        <header className="mb-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Workspace
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Appearance, integrations, and account preferences for this browser.
          </p>
        </header>

        <div className="space-y-3">
          <Section
            title="Appearance"
            description="Choose how BuildX looks. The choice is stored locally and applies before the page paints."
            icon={<Palette className="size-4" />}
          >
            <div className="space-y-3">
              <ThemeSwitch className="max-w-md" />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <MonitorCog className="size-3.5" />
                System follows your device setting and updates automatically.
              </div>
            </div>
          </Section>

          <Section
            title="GitHub"
            description="Connect a GitHub App so the agent can publish projects and open pull requests when you ask."
            icon={<GitPullRequest className="size-4" />}
          >
            <GitHubConnection />
          </Section>

          <Section
            title="Account"
            description="Signed-in identity and demo balance for this browser."
            icon={<UserRound className="size-4" />}
          >
            <div className="divide-y divide-border/60 text-xs">
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-muted-foreground">Name</span>
                <span className="truncate font-mono text-foreground/80">
                  {user?.name ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-muted-foreground">Email</span>
                <span className="truncate font-mono text-foreground/80">
                  {user?.email ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-muted-foreground">Credits</span>
                <span className="font-mono text-foreground/80">
                  {formatTaka(balance)}
                </span>
              </div>
            </div>
            <Link
              href="/pricing"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
            >
              Plans &amp; credits
              <ArrowUpRight className="size-3" />
            </Link>
          </Section>
        </div>
      </div>
    </div>
  );
}
