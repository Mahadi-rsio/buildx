"use client";

import { useMemo, useState } from "react";
import type { RunEvent } from "@buildx/shared";
import {
  CheckCircle2,
  ChevronDown,
  FilePenLine,
  FileSearch,
  Loader2,
  Search,
  ShieldAlert,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { pretty, toStreamItems, type StreamItem } from "@/components/run-events";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

function toolMeta(toolName: string): {
  label: string;
  icon: typeof Wrench;
  category: "read" | "edit" | "shell" | "search" | "plan" | "other";
} {
  const name = toolName.toLowerCase();
  if (name.includes("todo") || name.includes("plan")) {
    return { label: "Planning", icon: Wrench, category: "plan" };
  }
  if (
    name.includes("read") ||
    name.includes("list") ||
    name.includes("cat") ||
    name.includes("open")
  ) {
    return { label: "Reading files", icon: FileSearch, category: "read" };
  }
  if (
    name.includes("grep") ||
    name.includes("glob") ||
    name.includes("search") ||
    name.includes("find")
  ) {
    return { label: "Searching", icon: Search, category: "search" };
  }
  if (
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("patch") ||
    name.includes("create")
  ) {
    return { label: "Editing files", icon: FilePenLine, category: "edit" };
  }
  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("exec") ||
    name.includes("run") ||
    name.includes("test")
  ) {
    return { label: "Running command", icon: TerminalSquare, category: "shell" };
  }
  return { label: toolName, icon: Wrench, category: "other" };
}

function summarizeTool(item: Extract<StreamItem, { kind: "tool" }>): string {
  const input = item.input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["path", "file", "command", "pattern", "query", "cwd"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.length > 80 ? `${value.slice(0, 79)}…` : value;
      }
    }
  }
  return item.toolName;
}

function ToolActivityCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "tool" }>;
}) {
  const meta = toolMeta(item.toolName);
  const Icon = meta.icon;
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-card/50",
          item.isError
            ? "border-red-500/35"
            : item.pending
              ? "border-amber-500/25"
              : "border-border",
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/40">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              meta.category === "edit" && "text-emerald-400",
              meta.category === "shell" && "text-amber-300",
              meta.category === "search" && "text-sky-300",
              meta.category === "read" && "text-violet-300",
              meta.category === "plan" && "text-foreground/70",
              meta.category === "other" && "text-sky-300",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground/90">
              {meta.label}
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {summarizeTool(item)}
            </p>
          </div>
          {item.pending ? (
            <Loader2 className="size-3.5 animate-spin text-amber-300 motion-reduce:animate-none" />
          ) : item.isError ? (
            <XCircle className="size-3.5 text-red-400" />
          ) : (
            <CheckCircle2 className="size-3.5 text-emerald-400" />
          )}
          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/70 sm:inline">
            {formatClock(item.ts)}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {item.toolName}
            </p>
            {item.input !== undefined ? (
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                {pretty(item.input)}
              </pre>
            ) : null}
            {item.output !== undefined ? (
              <pre
                className={cn(
                  "max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]",
                  item.isError ? "text-red-300" : "text-muted-foreground",
                )}
              >
                {pretty(item.output)}
              </pre>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function ActivityCard({ item }: { item: StreamItem }) {
  if (item.kind === "tool") {
    return <ToolActivityCard item={item} />;
  }

  if (item.kind === "file_change") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
        <FilePenLine className="size-3.5 shrink-0 text-emerald-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-emerald-400">{item.change}</span>{" "}
          <span className="text-foreground/85">{item.path}</span>
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {formatClock(item.ts)}
        </span>
      </div>
    );
  }

  if (item.kind === "approval") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          Approval {item.status}:{" "}
          <span className="text-foreground">{item.command}</span>
        </span>
      </div>
    );
  }

  return null;
}

export function ActivityTimeline({
  events,
  compact = false,
}: {
  events: RunEvent[];
  compact?: boolean;
}) {
  const items = useMemo(
    () =>
      toStreamItems(events).filter(
        (item) =>
          item.kind === "tool" ||
          item.kind === "file_change" ||
          item.kind === "approval",
      ),
    [events],
  );

  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Tool activity will appear here as the agent works.
      </p>
    );
  }

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      {items.map((item) => (
        <ActivityCard key={item.key} item={item} />
      ))}
    </div>
  );
}
