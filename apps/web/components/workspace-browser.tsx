"use client";

import {
  ArrowLeft,
  ArrowUp,
  File,
  Folder,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FileContentResponse, FilesResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

export function WorkspaceBrowser({
  path,
  listing,
  file,
  error,
  onRefresh,
  onNavigate,
  onOpenFile,
  onBackFromFile,
}: {
  path: string;
  listing: FilesResponse | null;
  file: FileContentResponse | null;
  error: string | null;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onBackFromFile: () => void;
}) {
  const upPath = (() => {
    if (path === "." || path === "/") return null;
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? parts.join("/") : ".";
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {file ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onBackFromFile}
            aria-label="Back to directory"
          >
            <ArrowLeft />
          </Button>
        ) : upPath !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onNavigate(upPath)}
            aria-label="Parent directory"
          >
            <ArrowUp />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {file ? file.path : path}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRefresh}
          aria-label="Refresh workspace"
        >
          <RefreshCw />
        </Button>
      </div>

      {error ? (
        <p className="px-3 py-3 text-xs text-red-400">{error}</p>
      ) : file ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-3">
            <div className="mb-2 font-mono text-[11px] text-muted-foreground">
              {file.size} bytes
              {file.binary ? " · binary (not shown)" : ""}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
              {file.binary ? "" : file.content}
            </pre>
          </div>
        </ScrollArea>
      ) : listing ? (
        listing.entries.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            Empty — the agent has not written anything here yet.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="py-1">
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() =>
                      entry.type === "dir"
                        ? onNavigate(entry.path)
                        : onOpenFile(entry.path)
                    }
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition hover:bg-muted/60",
                      entry.type === "dir"
                        ? "text-amber-300/90"
                        : "text-foreground/85",
                    )}
                  >
                    {entry.type === "dir" ? (
                      <Folder className="size-3.5 shrink-0" />
                    ) : (
                      <File className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )
      ) : (
        <p className="px-3 py-3 text-xs text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
