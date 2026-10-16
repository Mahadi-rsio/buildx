"use client";

import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FilePen,
  FileText,
  ListTodo,
  Loader2,
  PauseCircle,
  Search,
  ShieldAlert,
  Terminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { pretty, type StreamItem } from "@/components/run-events";
import {
  CodePreview,
  CopyButton,
  DiffCode,
} from "@/components/agent/code-preview";
import { TerminalBlock } from "@/components/workspace/terminal-block";
import { guessLanguage } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";

type ActivityItem = Extract<
  StreamItem,
  | { kind: "tool" }
  | { kind: "file_change" }
  | { kind: "approval" }
  | { kind: "todo" }
>;

type ActivityStatus = "running" | "succeeded" | "failed" | "cancelled";

interface ActivityKind {
  /** Present-continuous verb while the step runs. */
  verb: string;
  /** Past-tense verb once the step is done. */
  done: string;
  /** Tailwind text color for the verb. */
  tone: string;
  /** Leading icon identifying the tool category. */
  icon: LucideIcon;
}

export function classifyTool(name: string): ActivityKind {
  const n = name.toLowerCase();
  if (
    n.includes("grep") ||
    n.includes("glob") ||
    n.includes("search") ||
    n.includes("find")
  ) {
    return {
      verb: "Searching",
      done: "Searched",
      tone: "text-info",
      icon: Search,
    };
  }
  if (
    n.includes("list") ||
    n.includes("read") ||
    n.includes("cat") ||
    n.includes("open")
  ) {
    return {
      verb: "Reading",
      done: "Read",
      tone: "text-info",
      icon: FileText,
    };
  }
  if (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("patch") ||
    n.includes("create")
  ) {
    return {
      verb: "Writing",
      done: "Wrote",
      tone: "text-success",
      icon: FilePen,
    };
  }
  if (
    n.includes("bash") ||
    n.includes("shell") ||
    n.includes("exec") ||
    n.includes("run")
  ) {
    return {
      verb: "Running",
      done: "Ran",
      tone: "text-warning",
      icon: Terminal,
    };
  }
  if (n.includes("todo") || n.includes("plan")) {
    return {
      verb: "Planning",
      done: "Planned",
      tone: "text-muted-foreground",
      icon: ListTodo,
    };
  }
  return {
    verb: "Using",
    done: "Used",
    tone: "text-info",
    icon: Wrench,
  };
}

/** Best single-line target (command, path, pattern, …) for a tool call. */
function toolTarget(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of [
    "command",
    "path",
    "file",
    "pattern",
    "query",
    "cwd",
    "url",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function resolve(item: ActivityItem): {
  kind: ActivityKind;
  target: string | null;
  running: boolean;
  failed: boolean;
} {
  if (item.kind === "tool") {
    return {
      kind: classifyTool(item.toolName),
      target: toolTarget(item.input),
      running: item.pending,
      failed: Boolean(item.isError),
    };
  }
  if (item.kind === "file_change") {
    const change =
      item.change === "create"
        ? { verb: "Creating", done: "Created" }
        : item.change === "edit"
          ? { verb: "Editing", done: "Edited" }
          : { verb: "Writing", done: "Wrote" };
    return {
      kind: {
        ...change,
        tone: "text-success",
        icon: FilePen,
      },
      target: item.path,
      running: false,
      failed: false,
    };
  }
  if (item.kind === "approval") {
    return {
      kind: {
        verb: "Awaiting approval",
        done: "Approved",
        tone: "text-warning",
        icon: ShieldAlert,
      },
      target: item.command,
      running: item.status === "pending",
      failed: item.status === "denied",
    };
  }
  return {
    kind: {
      verb: "Planning",
      done: "Planned",
      tone: "text-muted-foreground",
      icon: ListTodo,
    },
    target: null,
    running: false,
    failed: false,
  };
}

function isActivityItem(item: StreamItem): item is ActivityItem {
  return (
    item.kind === "tool" ||
    item.kind === "file_change" ||
    item.kind === "approval" ||
    item.kind === "todo"
  );
}

function StatusIcon({
  status,
  running,
  failed,
}: {
  status: ActivityStatus;
  running: boolean;
  failed: boolean;
}) {
  if (running) {
    return (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-warning motion-reduce:animate-none" />
    );
  }
  if (status === "cancelled") {
    return <PauseCircle className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (failed) {
    return <AlertCircle className="size-3.5 shrink-0 text-danger" />;
  }
  return <CheckCircle2 className="size-3.5 shrink-0 text-success/80" />;
}

/**
 * A single, compact, expandable row describing one real agent step.
 *
 * Collapses successful details by default; failed and running steps stay
 * visible and open so nothing important is hidden. Only renders data that
 * actually exists in the event stream — it never fabricates commands, exit
 * codes, durations, or results.
 */
export function ToolActivityRow({
  item,
  cancelled = false,
}: {
  item: StreamItem;
  /** Run was cancelled, so pending steps did not finish. */
  cancelled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!isActivityItem(item)) return null;

  const resolved = resolve(item);
  const failed = resolved.failed;
  const running = resolved.running && !cancelled;
  const status: ActivityStatus = cancelled
    ? "cancelled"
    : running
      ? "running"
      : failed
        ? "failed"
        : "succeeded";

  // Keep failures and cancellations visible instead of collapsing them.
  const effectiveOpen = open || status === "failed" || status === "cancelled";
  const label =
    running || (status === "cancelled" && resolved.running)
      ? resolved.kind.verb
      : resolved.kind.done;

  const showDetails =
    item.kind === "tool" &&
    (item.input !== undefined || item.output !== undefined);

  const Icon = resolved.kind.icon;

  return (
    <div
      className={cn(
        "rounded-md border transition-colors",
        failed
          ? "border-danger/30 bg-danger/[0.06]"
          : running
            ? "border-border bg-surface/40"
            : status === "cancelled"
              ? "border-border bg-surface/30"
              : "border-transparent",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={effectiveOpen}
        disabled={!showDetails && item.kind !== "todo" && item.kind !== "approval"}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left",
          (showDetails || item.kind === "todo" || item.kind === "approval") &&
            "cursor-pointer hover:bg-muted/40",
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", resolved.kind.tone)} />

        <span
          className={cn("shrink-0 text-xs font-medium", resolved.kind.tone)}
        >
          {label}
        </span>

        {resolved.target ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {resolved.target}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}

        {item.kind === "todo" ? (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
            {item.todos.filter((t) => t.status === "done").length}/
            {item.todos.length}
          </span>
        ) : null}

        <StatusIcon status={status} running={running} failed={failed} />

        {showDetails || item.kind === "todo" || item.kind === "approval" ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              effectiveOpen && "rotate-90",
            )}
          />
        ) : null}
      </button>

      {effectiveOpen ? (
        <div className="border-t border-border/60 p-2">
          {item.kind === "tool" ? (
            <ToolDetails item={item} failed={failed} />
          ) : item.kind === "todo" ? (
            <ul className="space-y-1">
              {item.todos.map((todo, i) => (
                <li
                  key={`${todo.content}-${i}`}
                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                >
                  <CircleDot
                    className={cn(
                      "mt-0.5 size-3 shrink-0",
                      todo.status === "done" && "text-success/80",
                      todo.status === "in_progress" && "text-warning",
                    )}
                  />
                  <span className={todo.status === "done" ? "line-through" : ""}>
                    {todo.content}
                  </span>
                </li>
              ))}
            </ul>
          ) : item.kind === "approval" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldAlert className="size-3.5 shrink-0 text-warning" />
              <span className="break-words font-mono">{item.command}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Coerce a tool input payload to a plain record (JSON string or object). */
function parseToolInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof input === "object") return input as Record<string, unknown>;
  return null;
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function ToolDetails({
  item,
  failed,
}: {
  item: Extract<StreamItem, { kind: "tool" }>;
  failed: boolean;
}) {
  const name = item.toolName.toLowerCase();
  const parsed = parseToolInput(item.input);
  const filename =
    toString(parsed?.path) ?? toString(parsed?.file) ?? undefined;
  const language = filename ? guessLanguage(filename) : undefined;

  let primary: ReactNode = null;
  let outputAlreadyShown = false;

  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("exec") ||
    name.includes("run")
  ) {
    primary = (
      <TerminalBlock
        command={toString(parsed?.command)}
        result={item.output}
        streaming={false}
      />
    );
    outputAlreadyShown = true;
  } else if (
    name.includes("write") ||
    name.includes("create") ||
    name.includes("patch")
  ) {
    const content = toString(parsed?.content);
    if (content !== undefined) {
      primary = (
        <CodePreview code={content} language={language} filename={filename} />
      );
    }
  } else if (name.includes("edit")) {
    const oldStr = toString(parsed?.old_str);
    const newStr = toString(parsed?.new_str);
    if (oldStr !== undefined && newStr !== undefined) {
      primary = (
        <DiffCode oldText={oldStr} newText={newStr} filename={filename} />
      );
    }
  } else if (name.includes("read")) {
    if (typeof item.output === "string") {
      primary = (
        <CodePreview code={item.output} language={language} filename={filename} />
      );
      outputAlreadyShown = true;
    }
  }

  const showArgs = !primary && item.input !== undefined;
  const showOutput = !outputAlreadyShown && item.output !== undefined;
  const outputText =
    typeof item.output === "string"
      ? item.output
      : item.output !== undefined
        ? pretty(item.output)
        : "";

  return (
    <div className="space-y-2">
      {primary ? <div>{primary}</div> : null}

      {showArgs ? (
        <div>
          <p className="mb-0.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
            Arguments
          </p>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface/40 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
            {pretty(item.input)}
          </pre>
        </div>
      ) : null}

      {showOutput ? (
        <div>
          <div className="mb-0.5 flex items-center justify-between">
            <p className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
              Output
            </p>
            <CopyButton value={outputText} label="Copy output" />
          </div>
          <pre
            className={cn(
              "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface/40 p-2 font-mono text-xs leading-relaxed",
              failed ? "text-danger" : "text-foreground/85",
            )}
          >
            {outputText}
          </pre>
        </div>
      ) : null}

      {failed ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
          <XCircle className="size-3.5 shrink-0" />
          Step failed
        </p>
      ) : null}
    </div>
  );
}