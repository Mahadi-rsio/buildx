"use client";

import { Fragment, useMemo } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  FolderTree,
  Home,
  RefreshCw,
} from "lucide-react";
import { FileIcon } from "@/components/workspace/file-icon";
import { CodeViewer } from "@/components/workspace/code-viewer";
import { DiffView } from "@/components/workspace/diff-view";
import { File, Tree, type TreeViewElement } from "@/components/ui/file-tree";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  DiffFile,
  FileContentResponse,
  FilesResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

function listingToTree(listing: FilesResponse | null): TreeViewElement[] {
  if (!listing) return [];
  return listing.entries.map((entry) => ({
    id: entry.path,
    name: entry.name,
    type: entry.type === "dir" ? "folder" : "file",
    isSelectable: true,
    children: entry.type === "dir" ? [] : undefined,
  }));
}

function Unavailable({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="mb-1 flex size-9 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <FolderTree className="size-4" />
      </span>
      <p className="text-sm font-medium text-foreground/90">{title}</p>
      <p className="max-w-60 text-secondary leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function PathCrumbs({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const parts = path === "." ? [] : path.split("/").filter(Boolean);
  return (
    <nav
      aria-label="Workspace folders"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-secondary [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <button
        type="button"
        onClick={() => onNavigate(".")}
        aria-label="Workspace root"
        className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
      >
        <Home className="size-3.5" />
      </button>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join("/");
        const last = index === parts.length - 1;
        return (
          <Fragment key={target}>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className={cn(
                "max-w-32 shrink-0 truncate rounded px-1 py-0.5 transition hover:bg-muted/60 hover:text-foreground",
                last ? "text-foreground/85" : "text-muted-foreground",
              )}
            >
              {part}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

function FileTreeView({
  listing,
  path,
  onNavigate,
  onOpenFile,
}: {
  listing: FilesResponse;
  path: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const tree = useMemo(() => listingToTree(listing), [listing]);
  const parts = path === "." ? [] : path.split("/").filter(Boolean);
  const parentPath = parts.length ? parts.slice(0, -1).join("/") || "." : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {path !== "." ? (
        <div className="mb-1 px-2 pt-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="w-full justify-start"
            onClick={() => parentPath && onNavigate(parentPath)}
          >
            <FolderOpen className="size-3" />
            Up to parent
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Tree
          className="h-full"
          elements={tree}
          initialExpandedItems={[]}
          indicator={false}
          sort="default"
        >
          {tree.map((el) =>
            el.type === "folder" ? (
              <File
                key={el.id}
                value={el.id}
                fileIcon={
                  <span className="text-[var(--text-muted)]">
                    <FolderTree className="size-4" />
                  </span>
                }
                handleSelect={(id) => {
                  if (el.type === "folder") onNavigate(id);
                  else void onOpenFile(id);
                }}
              >
                <span className="truncate">{el.name}</span>
              </File>
            ) : (
              <File
                key={el.id}
                value={el.id}
                fileIcon={<FileIcon path={el.id} className="size-4" />}
                handleSelect={(id) => {
                  if (el.type === "folder") onNavigate(id);
                  else void onOpenFile(id);
                }}
              >
                <span className="truncate">{el.name}</span>
              </File>
            ),
          )}
        </Tree>
      </div>
    </div>
  );
}

export function WorkspacePanel({
  workspaceId,
  path,
  listing,
  file,
  filesError,
  diffFiles,
  diffUnchanged,
  diffStatus,
  onNavigate,
  onOpenFile,
  onBackFromFile,
  onRefresh,
  onOpenFromDiff,
  tab,
  onTabChange,
  className,
}: {
  workspaceId: string;
  path: string;
  listing: FilesResponse | null;
  file: FileContentResponse | null;
  filesError: string | null;
  diffFiles: DiffFile[];
  diffUnchanged: number;
  diffStatus: "loading" | "ready" | "error";
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onBackFromFile: () => void;
  onRefresh: () => void;
  /** Open a changed file in the Files tab (from the Changes tab). */
  onOpenFromDiff: (path: string) => void;
  /** Controlled active tab. */
  tab?: string;
  onTabChange?: (tab: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-sidebar/40", className)}>
      <Tabs
        value={tab}
        defaultValue="files"
        onValueChange={(next) => onTabChange?.(String(next))}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-sidebar/60 px-1.5">
          <TabsList className="h-7 w-full gap-0.5 rounded-lg p-px">
            <TabsTrigger
              value="files"
              className="gap-1.5 rounded-md px-2.5 text-xs data-active:bg-muted/70"
            >
              <FolderTree className="size-3.5" />
              Files
            </TabsTrigger>
            <TabsTrigger
              value="changes"
              className="gap-1.5 rounded-md px-2.5 text-xs data-active:bg-muted/70"
            >
              <FolderOpen className="size-3.5" />
              Changes
              {diffFiles.length > 0 ? (
                <span className="rounded-full bg-[var(--surface-hover)] px-1.5 py-px font-mono text-[10px] tabular-nums text-[var(--text)]">
                  {diffFiles.length}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border bg-sidebar/60 px-2 py-1.5">
              {file ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Back to file tree"
                    onClick={onBackFromFile}
                  >
                    <ArrowLeft className="size-3.5" />
                  </Button>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <FileIcon path={file.path} className="size-4" />
                    <span className="min-w-0 flex-1 truncate font-mono text-secondary text-foreground/85">
                      {file.path}
                    </span>
                  </div>
                </div>
              ) : (
                <PathCrumbs path={path} onNavigate={onNavigate} />
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh files"
                onClick={onRefresh}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>

            <div className="min-h-0 flex-1">
              {filesError ? (
                <p className="px-3 py-3 text-xs text-[var(--text-muted)]">{filesError}</p>
              ) : file ? (
                <CodeViewer
                  path={file.path}
                  content={file.binary ? "" : file.content}
                />
              ) : listing ? (
                <FileTreeView
                  listing={listing}
                  path={path}
                  onNavigate={onNavigate}
                  onOpenFile={onOpenFile}
                />
              ) : (
                <Unavailable
                  title="Empty workspace"
                  detail="Files appear here as the agent writes them."
                />
              )}
            </div>

            <p className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              <FolderTree className="size-3 shrink-0 text-[var(--text-faint)]" />
              <span className="truncate">
                workspace/{workspaceId.slice(0, 12)}
              </span>
            </p>
          </div>
        </TabsContent>

        <TabsContent value="changes" className="min-h-0 flex-1 overflow-hidden">
          {diffStatus === "loading" && diffFiles.length === 0 ? (
            <Unavailable
              title="Building the diff"
              detail="Diffing the workspace against the run-start baseline…"
            />
          ) : diffStatus === "error" && diffFiles.length === 0 ? (
            <Unavailable
              title="Diff unavailable"
              detail="The diff endpoint could not be reached for this run."
            />
          ) : (
            <DiffView
              files={diffFiles}
              unchanged={diffUnchanged}
              onOpenFile={(target) => {
                onOpenFromDiff(target);
                onTabChange?.("files");
              }}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}