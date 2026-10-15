"use client";

import { FolderTree } from "lucide-react";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { RunEvent } from "@buildx/shared";
import type { FileContentResponse, FilesResponse } from "@/lib/types";
import { useShell, type PanelTab } from "@/components/shell/shell-context";

/** Workspace state a page hands to the right panel. */
export interface WorkspaceData {
  workspaceId: string;
  events: RunEvent[];
  path: string;
  listing: FilesResponse | null;
  file: FileContentResponse | null;
  filesError: string | null;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onBackFromFile: () => void;
  onRefresh: () => void;
  readFileContent: (path: string) => Promise<string | null>;
}

function PanelHeader({ title }: { title: string }) {
  const { setPanelOpen } = useShell();
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <FolderTree className="size-3.5" />
        {title}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Hide workspace panel"
        onClick={() => setPanelOpen(false)}
      >
        <span className="text-[13px] leading-none" aria-hidden>
          ›
        </span>
      </Button>
    </div>
  );
}

/** Shared body: the real workspace panel wired to shell tab state. */
function PanelBody(props: WorkspaceData) {
  const { panelTab, setPanelTab } = useShell();
  return (
    <WorkspacePanel
      workspaceId={props.workspaceId}
      events={props.events}
      path={props.path}
      listing={props.listing}
      file={props.file}
      filesError={props.filesError}
      onNavigate={props.onNavigate}
      onOpenFile={props.onOpenFile}
      onBackFromFile={props.onBackFromFile}
      onRefresh={props.onRefresh}
      readFileContent={props.readFileContent}
      tab={panelTab}
      onTabChange={(tab) => setPanelTab(tab as PanelTab)}
    />
  );
}

/** Desktop: header + workspace panel inside the resizable region. */
export function RightPanel(props: WorkspaceData) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PanelHeader title="Workspace" />
      <div className="min-h-0 flex-1">
        <PanelBody {...props} />
      </div>
    </div>
  );
}

/** Shown instead of the panel when a run hasn't created a workspace yet. */
export function EmptyWorkspace() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-sidebar/40 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground/90">
        No workspace yet
      </p>
      <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">
        A scratch workspace is created the moment a run starts. Files, diffs,
        and terminal output stream here live.
      </p>
    </div>
  );
}

/** Mobile: same body in a right-side drawer. */
export function RightPanelDrawer({
  open,
  onOpenChange,
  ...props
}: WorkspaceData & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 overflow-hidden p-0 data-[side=right]:w-3/4 sm:max-w-md lg:max-w-lg"
        showCloseButton={false}
      >
        <SheetTitle className="sr-only">Workspace</SheetTitle>
        <PanelHeader title="Workspace" />
        <div className="min-h-0 flex-1">
          <PanelBody {...props} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
