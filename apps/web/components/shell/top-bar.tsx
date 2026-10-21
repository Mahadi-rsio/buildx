"use client";

import Link from "next/link";
import { BarChart3, PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { useShell } from "@/components/shell/shell-context";

export function TopBar() {
  const isMobile = useIsMobile();
  const {
    collapsed,
    toggleCollapsed,
    setSidebarOpen,
    setUsageOpen,
    panelOpen,
    togglePanel,
  } = useShell();

  return (
    <header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-border bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl sm:gap-1.5 sm:px-3">
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {isMobile ? (
          <Button
            type="button"
            size="icon-touch"
            variant="ghost"
            aria-label="Open conversations"
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeft className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-touch"
            variant="ghost"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
          >
            <PanelLeft className="size-4" />
          </Button>
        )}

        <Link
          href="/"
          aria-label="Buildx home"
          className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/50"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-background">
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
              <path
                fill="currentColor"
                d="M8 1 2 4v8l6 3 6-3V4L8 1Zm0 2.2 4 2v4.6l-4 2-4-2V5.2l4-2Z"
              />
            </svg>
          </span>
          <span className="hidden font-mono text-sm font-semibold tracking-tight sm:inline">
            buildx
          </span>
        </Link>
      </div>

      <div className="min-w-0 flex-1" />

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Usage"
          title="Usage"
          onClick={() => setUsageOpen(true)}
        >
          <BarChart3 className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label={panelOpen ? "Hide workspace panel" : "Show workspace panel"}
          aria-pressed={panelOpen}
          onClick={togglePanel}
          className={panelOpen ? "bg-[var(--surface-hover)]" : undefined}
        >
          <PanelRight className="size-4" />
        </Button>
        <ProfileMenu />
      </div>
    </header>
  );
}
