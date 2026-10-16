"use client";

import Link from "next/link";
import {
  BarChart3,
  PanelLeft,
  PanelRight,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/model-picker";
import { useIsMobile } from "@/hooks/use-mobile";
import { useShell } from "@/components/shell/shell-context";
import { cn } from "@/lib/utils";

export function TopBar() {
  const isMobile = useIsMobile();
  const {
    meta,
    collapsed,
    toggleCollapsed,
    setSidebarOpen,
    setSettingsOpen,
    setUsageOpen,
    modelOverride,
    setModelOverride,
    panelOpen,
    togglePanel,
  } = useShell();

  const status = meta.status;
  const live = status === "running" || status === "queued";
  const waiting = status === "waiting_input";
  const failed = status === "failed";
  const cancelled = status === "cancelled";

  const label = live
    ? "Working…"
    : waiting
      ? "Awaiting input"
      : failed
        ? "Failed"
        : cancelled
          ? "Stopped"
          : null;
  const labelClass = live || waiting ? "text-warning" : failed ? "text-danger" : "text-muted-foreground";

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background/80 px-2 backdrop-blur sm:gap-2 sm:px-3">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5">
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
          className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 transition hover:bg-muted/50"
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

      {/* Center: truncated run title + slim live status, no pill. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden px-1">
        {meta.task ? (
          <span
            title={meta.task}
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {meta.task}
          </span>
        ) : null}
        {label ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-2xs font-medium",
              labelClass,
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full bg-current",
                (live || waiting) && "animate-pulse motion-reduce:animate-none",
              )}
            />
            {label}
          </span>
        ) : null}
        {status === "completed" ? (
          <span className="sr-only">Run completed</span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <ModelPicker
          value={modelOverride}
          onChange={setModelOverride}
          align="end"
          className="hidden min-[420px]:flex sm:max-w-52"
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Usage"
          onClick={() => setUsageOpen(true)}
        >
          <BarChart3 className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 className="size-4" />
        </Button>
        <Button
          type="button"
          variant={panelOpen ? "secondary" : "ghost"}
          size="icon-touch"
          aria-label={panelOpen ? "Hide workspace panel" : "Show workspace panel"}
          aria-pressed={panelOpen}
          onClick={togglePanel}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
    </header>
  );
}