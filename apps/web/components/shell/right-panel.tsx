"use client";

import { FolderTree, PanelRightClose } from "lucide-react";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { RunEvent } from "@buildx/shared";
import type {
  DiffFallbackFile,
  DiffFile,
  FileContentResponse,
  FilesResponse,
} from "@/lib/types";
import { useShell, type PanelTab } from "@/components/shell/shell-context";

/** Live diff state handed from the page to the Changes tab. */
export interface WorkspaceDiff {
  files: DiffFile[];
  unchanged: number;
  status: "loading" | "ready" | "error";
  error: string | null;
  fallbackFiles: DiffFallbackFile[];
  onRefresh: () => void;
}

/** Workspace state a page hands to the right panel. */
export interface WorkspaceData {
  workspaceId: string;
  events: RunEvent[];
  path: string;
  listing: FilesResponse | null;
  file: FileContentResponse | null;
  filesLoading: boolean;
  filesError: string | null;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onBackFromFile: () => void;
  onRefresh: () => void;
  readFileContent: (path: string) => Promise<string | null>;
  /** Diff state for the Changes tab. */
  diff: WorkspaceDiff;
  /** Open a changed file in the Files tab. */
  onOpenFromDiff: (path: string) => void;
}

function PanelHeader({ title }: { title: string }) {
  const { setPanelOpen, meta } = useShell();
  const workspaceId = meta.workspaceId;
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-sidebar/60 px-3">
      <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <FolderTree className="size-3.5 shrink-0" />
        <span className="shrink-0">{title}</span>
        {workspaceId ? (
          <span
            className="truncate rounded bg-muted/60 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-muted-foreground/80"
            title={`workspace/${workspaceId}`}
          >
            ws/{workspaceId.slice(0, 8)}
          </span>
        ) : null}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Hide workspace panel"
          onClick={() => setPanelOpen(false)}
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Shared body: the real workspace panel wired to shell tab state. */
function PanelBody(props: WorkspaceData) {
  const { panelTab, setPanelTab } = useShell();
  return (
    <WorkspacePanel
      workspaceId={props.workspaceId}
      path={props.path}
      listing={props.listing}
      file={props.file}
      filesLoading={props.filesLoading}
      filesError={props.filesError}
      diffFiles={props.diff.files}
      diffUnchanged={props.diff.unchanged}
      diffStatus={props.diff.status}
      diffError={props.diff.error}
      diffFallback={props.diff.fallbackFiles}
      onRefreshDiff={props.diff.onRefresh}
      onNavigate={props.onNavigate}
      onOpenFile={props.onOpenFile}
      onBackFromFile={props.onBackFromFile}
      onRefresh={props.onRefresh}
      onOpenFromDiff={props.onOpenFromDiff}
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
      <span className="mb-1 flex size-10 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <FolderTree className="size-4.5" />
      </span>
      <p className="text-sm font-medium text-foreground/90">
        No workspace yet
      </p>
      <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">
        A workspace starts lazily on the first tool call. Files, diffs, and
        terminal output stream here once the sandbox is ready.
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
