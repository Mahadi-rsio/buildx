"use client";

import Link from "next/link";
import {
  BarChart3,
  Check,
  ChevronDown,
  FolderOpen,
  PanelLeft,
  PanelRight,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/status-badge";
import { useConfig } from "@/hooks/use-config";
import { useIsMobile } from "@/hooks/use-mobile";
import { useShell } from "@/components/shell/shell-context";

export function TopBar() {
  const { config } = useConfig();
  const isMobile = useIsMobile();
  const {
    meta,
    collapsed,
    toggleCollapsed,
    setSidebarOpen,
    panelOpen,
    togglePanel,
    setSettingsOpen,
    setUsageOpen,
    modelOverride,
    setModelOverride,
  } = useShell();

  const effectiveModel = modelOverride.trim() || meta.model || config?.model;
  const workspaceLabel = meta.workspaceId
    ? meta.workspaceId
    : "no workspace yet";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur">
      {isMobile ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Open conversations"
          onClick={() => setSidebarOpen(true)}
        >
          <PanelLeft className="size-4" />
        </Button>
      ) : (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleCollapsed}
        >
          <PanelLeft className="size-4" />
        </Button>
      )}

      <Link
        href="/"
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition hover:bg-muted/50"
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-background">
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path
              fill="currentColor"
              d="M8 1 2 4v8l6 3 6-3V4L8 1Zm0 2.2 4 2v4.6l-4 2-4-2V5.2l4-2Z"
            />
          </svg>
        </span>
        <span className="font-mono text-sm font-semibold tracking-tight">
          buildx
        </span>
      </Link>

      <span
        className="hidden max-w-[10rem] truncate rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground md:inline-block"
        title={workspaceLabel}
      >
        <FolderOpen className="mr-1 inline size-3" />
        {workspaceLabel === "no workspace yet" ? workspaceLabel : `ws/${workspaceLabel.slice(0, 8)}`}
      </span>

      <div className="mx-auto flex items-center gap-2">
        {meta.status !== "idle" ? (
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2.5 py-1">
            <StatusBadge status={meta.status} />
          </span>
        ) : null}
        {meta.status === "running" || meta.status === "queued" ? (
          <span className="hidden items-center gap-1.5 font-mono text-[10px] text-amber-300 sm:flex">
            <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
            live
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" size="sm" className="gap-1 font-mono text-xs" />
            }
          >
            <span className="max-w-[9rem] truncate">{effectiveModel}</span>
            <ChevronDown className="size-3 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuLabel>Model for new runs</DropdownMenuLabel>
            {config ? (
              <DropdownMenuItem
                onClick={() => setModelOverride("")}
                className="justify-between font-mono text-xs"
              >
                <span className="truncate">{config.model}</span>
                {modelOverride.trim().length === 0 ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    default
                  </span>
                )}
              </DropdownMenuItem>
            ) : null}
            {modelOverride.trim().length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setModelOverride("")}
                  className="justify-between font-mono text-xs"
                >
                  <span className="truncate">{modelOverride.trim()}</span>
                  <Check className="size-3.5" />
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setSettingsOpen(true)}
              className="text-xs"
            >
              Edit default override…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Usage"
          onClick={() => setUsageOpen(true)}
        >
          <BarChart3 className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 className="size-4" />
        </Button>
        {!isMobile ? (
          <Button
            type="button"
            variant={panelOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={panelOpen ? "Hide workspace panel" : "Show workspace panel"}
            aria-pressed={panelOpen}
            onClick={togglePanel}
          >
            <PanelRight className="size-4" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
