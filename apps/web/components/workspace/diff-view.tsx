"use client";

import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileArchive,
} from "lucide-react";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/types";
import { guessLanguage } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  A: "added",
  M: "modified",
  D: "deleted",
};

const STATUS_TONE: Record<DiffFile["status"], string> = {
  A: "bg-[var(--surface-hover)] text-[var(--text)]",
  M: "bg-[var(--surface)] text-[var(--text-muted)]",
  D: "bg-[var(--surface)] text-[var(--text-faint)]",
};

function HunkLine({ line }: { line: DiffLine }) {
  const classes =
    line.type === "add"
      ? "bg-[var(--surface-hover)] text-[var(--text)]"
      : line.type === "del"
        ? "text-[var(--text-faint)] line-through"
        : "text-[var(--text-muted)]";
  const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <div className={cn("flex w-full min-w-0 leading-[1.6]", classes)}>
      <span
        className="w-4 shrink-0 select-none text-center text-muted-foreground/40"
        aria-hidden
      >
        {sign}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3">
        {line.text || " "}
      </span>
    </div>
  );
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="flex items-center gap-2 px-1 py-0.5 font-mono text-[10px] text-muted-foreground/70">
      <span className="select-none">@@</span>
      <span className="tabular-nums">-{hunk.oldStart},{hunk.oldLines}</span>
      <span className="tabular-nums">+{hunk.newStart},{hunk.newLines}</span>
      <span className="select-none">@@</span>
    </div>
  );
}

const COLLAPSE_HUNK_LINES = 60;

function DiffHunkView({ hunk }: { hunk: DiffHunk }) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && hunk.lines.length > COLLAPSE_HUNK_LINES;
  return (
    <div>
      <HunkHeader hunk={hunk} />
      <div>
        {hunk.lines.slice(0, collapsed ? COLLAPSE_HUNK_LINES : undefined).map((line, i) => (
          <HunkLine key={i} line={line} />
        ))}
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-1.5 px-2 py-1 font-mono text-[10px] text-[var(--text-muted)] transition hover:bg-muted/40"
          aria-expanded={false}
        >
          <ChevronRight className="size-3" />
          Show {hunk.lines.length - COLLAPSE_HUNK_LINES} more lines
        </button>
      ) : null}
    </div>
  );
}

function DiffFileCard({
  file,
  defaultOpen,
  onOpen,
}: {
  file: DiffFile;
  defaultOpen: boolean;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const language = guessLanguage(file.path);
  const isDeleted = file.status === "D";
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (file.status === "D") onOpen();
        }}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-muted/30"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className={cn("min-w-0 flex-1")}>
          {dir ? (
            <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
              {dir}/
            </span>
          ) : null}
          <span className="block truncate font-mono text-xs font-medium text-foreground/85">
            {file.path.split("/").pop()}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {language}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-px font-mono text-[10px] uppercase tracking-wide",
            STATUS_TONE[file.status],
          )}
        >
          {STATUS_LABEL[file.status][0]}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">
          {file.deletions > 0 ? `−${file.deletions}` : ""}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
          {file.additions > 0 ? `+${file.additions}` : ""}
        </span>
      </button>

      {open ? (
        <div className="border-t border-border/60 p-1.5">
          {file.binary ? (
            <div className="flex items-center gap-2 px-1 py-2 font-mono text-[11px] text-muted-foreground">
              <FileArchive className="size-3.5 shrink-0" />
              Binary or oversized file — content not shown.
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="px-1 py-2 font-mono text-[11px] text-muted-foreground">
              No textual changes detected.
            </div>
          ) : (
            <div className="rounded-md bg-surface/60" data-lang={language}>
              {file.hunks.map((hunk, i) => (
                <DiffHunkView key={i} hunk={hunk} />
              ))}
              {isDeleted ? (
                <div className="px-1 py-1 font-mono text-[10px] text-muted-foreground/70">
                  File deleted.
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The Changes tab body: summary bar + collapsible per-file unified diffs. */
export function DiffView({
  files,
  unchanged,
  onOpenFile,
}: {
  files: DiffFile[];
  unchanged: number;
  onOpenFile: (path: string) => void;
}) {
  const [allOpen, setAllOpen] = useState(false);

  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({
          additions: acc.additions + file.additions,
          deletions: acc.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <ChevronsDownUp className="size-5 text-muted-foreground/50" />
        <p className="text-secondary font-medium text-foreground/90">
          No changes yet
        </p>
        <p className="max-w-56 text-secondary text-muted-foreground">
          Files the agent adds or edits appear here as the run streams.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-sidebar/60 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed
          <span className="ml-1.5 text-[var(--text)]">{`+${totals.additions}`}</span>
          <span className="ml-1 text-[var(--text-faint)]">{`−${totals.deletions}`}</span>
          {unchanged > 0 ? (
            <span className="ml-1.5 text-muted-foreground/60">
              · {unchanged} unchanged
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
        >
          {allOpen ? (
            <ChevronsUpDown className="size-3.5" />
          ) : (
            <ChevronsDownUp className="size-3.5" />
          )}
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto overscroll-contain p-2">
        {files.map((file) => (
          <DiffFileCard
            key={`${allOpen}:${file.path}`}
            file={file}
            defaultOpen={allOpen}
            onOpen={() => void onOpenFile(file.path)}
          />
        ))}
      </div>
    </div>
  );
}