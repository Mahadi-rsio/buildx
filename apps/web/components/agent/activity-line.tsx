"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import type { StreamItem } from "@/components/run-events";
import { cn } from "@/lib/utils";

type ActivityItem = Extract<
  StreamItem,
  { kind: "tool" } | { kind: "file_change" } | { kind: "approval" } | { kind: "todo" }
>;

interface Kind {
  /** Present-continuous verb shown while the step runs. */
  verb: string;
  /** Past-tense verb shown once the step is done. */
  done: string;
  tone: string;
}

function classify(name: string): Kind {
  const n = name.toLowerCase();
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("find")) {
    return { verb: "Searching", done: "Searched", tone: "text-sky-300" };
  }
  if (n.includes("list") || n.includes("read") || n.includes("cat") || n.includes("open")) {
    return { verb: "Reading", done: "Read", tone: "text-violet-300" };
  }
  if (n.includes("write") || n.includes("edit") || n.includes("patch") || n.includes("create")) {
    return { verb: "Writing", done: "Wrote", tone: "text-emerald-300" };
  }
  if (n.includes("bash") || n.includes("shell") || n.includes("exec") || n.includes("run")) {
    return { verb: "Running", done: "Ran", tone: "text-amber-300" };
  }
  if (n.includes("todo") || n.includes("plan")) {
    return { verb: "Planning", done: "Planned", tone: "text-foreground/70" };
  }
  return { verb: "Using", done: "Used", tone: "text-sky-300" };
}

function targetOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file", "command", "pattern", "query", "cwd", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length > 72 ? `${trimmed.slice(0, 71)}…` : trimmed;
    }
  }
  return null;
}

function isActivityItem(item: StreamItem): item is ActivityItem {
  return (
    item.kind === "tool" ||
    item.kind === "file_change" ||
    item.kind === "approval" ||
    item.kind === "todo"
  );
}

/** A single hairline row describing one agent step — no boxes or chrome. */
export function ActivityLine({ item }: { item: StreamItem }) {
  if (!isActivityItem(item)) return null;

  let kind: Kind;
  let target: string | null = null;
  let pending = false;
  let isError = false;
  let suffix: string | null = null;

  if (item.kind === "tool") {
    kind = classify(item.toolName);
    target = targetOf(item.input);
    pending = item.pending;
    isError = Boolean(item.isError);
  } else if (item.kind === "file_change") {
    kind = {
      verb:
        item.change === "create"
          ? "Creating"
          : item.change === "edit"
            ? "Editing"
            : "Writing",
      done:
        item.change === "create"
          ? "Created"
          : item.change === "edit"
            ? "Edited"
            : "Wrote",
      tone: "text-emerald-300",
    };
    target = item.path;
  } else if (item.kind === "approval") {
    kind = { verb: "Awaiting approval", done: "Approved", tone: "text-amber-300" };
    target = item.command;
    pending = item.status === "pending";
    isError = item.status === "denied";
  } else {
    kind = { verb: "Planning", done: "Planned", tone: "text-foreground/70" };
    suffix = `${item.todos.filter((t) => t.status === "done").length}/${item.todos.length}`;
  }

  const label = pending || (!target && !suffix) ? kind.verb : kind.done;

  return (
    <div className="group/line flex min-w-0 items-center gap-2 py-0.5 text-[13px] leading-relaxed">
      <span className="relative inline-flex w-[4.75rem] shrink-0 justify-end">
        <span className={cn("relative overflow-hidden font-medium", kind.tone)}>
          {label}
          {pending ? (
            <span
              aria-hidden
              className="shimmer-sweep pointer-events-none absolute inset-0 motion-reduce:hidden"
            />
          ) : null}
        </span>
      </span>

      {target ? (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {target}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      {suffix ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {suffix}
        </span>
      ) : null}

      {pending ? (
        <span className="flex shrink-0 items-center gap-0.5" aria-label="in progress">
          <Dot delay="0s" />
          <Dot delay="0.15s" />
          <Dot delay="0.3s" />
        </span>
      ) : isError ? (
        <XCircle className="size-3.5 shrink-0 text-red-400" />
      ) : target ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400/70" />
      ) : null}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1 animate-pulse rounded-full bg-muted-foreground/70 motion-reduce:animate-none"
      style={{ animationDelay: delay }}
    />
  );
}
