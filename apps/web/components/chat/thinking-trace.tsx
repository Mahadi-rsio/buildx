"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type { ChatBlock } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";

/**
 * The "thinking trace": a row of short vertical strokes that light up in
 * sequence left-to-right, suggesting a stream of computation. Monochrome by
 * design; honors `prefers-reduced-motion` (see the `bx-trace-bar` CSS).
 */
const BARS = [
  { h: 5, d: "0s" },
  { h: 8, d: "0.28s" },
  { h: 11, d: "0.56s" },
  { h: 8, d: "0.84s" },
  { h: 5, d: "1.12s" },
];

export function ThinkingTrace({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-3 items-end gap-[2px]", className)}
    >
      {BARS.map((bar, i) => (
        <span
          key={i}
          className="bx-trace-bar"
          style={{ height: bar.h, "--bx-delay": bar.d } as CSSProperties}
        />
      ))}
    </span>
  );
}

/** What the agent is demonstrably doing right now, and for how long. */
interface ActivityState {
  label: string;
  /** Path/command/pattern the work is aimed at, when known. */
  target: string | null;
  /** True when `ts` is a real event timestamp worth counting elapsed time from. */
  anchored: boolean;
  ts: number;
}

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

function baseName(target: string): string | null {
  const base = target.split("/").pop();
  return base ? base : target;
}

const TEST_RE =
  /\b(test|tests|vitest|jest|playwright|pytest|go test|npm test|pnpm test)\b/;
const BUILD_RE =
  /\b(build|compile|typecheck|tsc|next build|pnpm build|tsc --noEmit)\b/;
const LINT_RE = /\b(lint|eslint|prettier)\b/;
const INSTALL_RE = /\b(install|add|ci)\b/;

function commandKind(command: string | null): string {
  const c = (command ?? "").toLowerCase();
  if (TEST_RE.test(c)) return "Running tests";
  if (BUILD_RE.test(c)) return "Checking build";
  if (LINT_RE.test(c)) return "Running lint";
  if (INSTALL_RE.test(c)) return "Installing dependencies";
  return "Running command";
}

function toolState(item: Extract<ChatBlock["item"], { kind: "tool" }>): ActivityState {
  const name = item.toolName.toLowerCase();
  const target = toolTarget(item.input);
  const base = target ? baseName(target) : null;

  let label: string;
  if (
    name.includes("grep") ||
    name.includes("glob") ||
    name.includes("search") ||
    name.includes("find") ||
    name.includes("select")
  ) {
    label = target ? `Searching for ${target}` : "Searching the codebase";
  } else if (
    name.includes("list") ||
    name.includes("read") ||
    name.includes("cat") ||
    name.includes("open") ||
    name.includes("view")
  ) {
    label = base ? `Reading ${base}` : "Reading files";
  } else if (
    name.includes("write") ||
    name.includes("create") ||
    name.includes("patch")
  ) {
    label = base ? `Writing ${base}` : "Writing files";
  } else if (
    name.includes("edit") ||
    name.includes("replace") ||
    name.includes("insert")
  ) {
    label = base ? `Editing ${base}` : "Editing files";
  } else if (name.includes("todo") || name.includes("plan")) {
    label = "Planning changes";
  } else if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("exec") ||
    name.includes("run") ||
    name.includes("terminal")
  ) {
    label = commandKind(target);
  } else if (name.includes("approve") || name.includes("deny")) {
    label = "Awaiting approval";
  } else {
    label = "Working";
  }

  return { label, target, anchored: true, ts: item.ts };
}

/**
 * Derive what the agent is doing right now from real blocks, newest first:
 * the last pending tool or pending approval, then streaming text, else a
 * generic "Working". Never invents activity that isn't in the event stream.
 */
export function resolveActivityState(blocks: ChatBlock[]): ActivityState {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const item = blocks[i]?.item;
    if (!item) continue;
    if (item.kind === "tool" && item.pending) return toolState(item);
    if (item.kind === "approval" && item.status === "pending") {
      return {
        label: "Waiting for approval",
        target: item.command ?? null,
        anchored: true,
        ts: item.ts,
      };
    }
  }
  if (blocks.some((block) => block.streaming)) {
    return { label: "Generating response", target: null, anchored: false, ts: Date.now() };
  }
  return { label: "Working", target: null, anchored: false, ts: Date.now() };
}

function keyOf(state: ActivityState): string {
  return `${state.label}\u0000${state.target ?? ""}`;
}

/** Keep one label steady during quick event bursts, then swap in the latest. */
function useStableActivity(state: ActivityState): ActivityState {
  const [display, setDisplay] = useState(state);
  const lastKey = useRef(keyOf(state));

  useEffect(() => {
    const nextKey = keyOf(state);
    if (nextKey === lastKey.current) return;
    lastKey.current = nextKey;
    const id = window.setTimeout(() => setDisplay(state), 450);
    return () => window.clearTimeout(id);
  }, [state]);

  return display;
}

function useElapsedSeconds(since: number | null): number {
  return useSyncExternalStore(
    (onStoreChange) => {
      const id = window.setInterval(onStoreChange, 1000);
      return () => window.clearInterval(id);
    },
    () => (since === null ? 0 : Math.floor((Date.now() - since) / 1000)),
  );
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * The full thinking indicator: trace mark + contextual label + target +
 * elapsed time, surfaced live while the run is in flight.
 */
export function ThinkingStatus({ blocks }: { blocks: ChatBlock[] }) {
  const state = useMemo(() => resolveActivityState(blocks), [blocks]);
  const stable = useStableActivity(state);
  const elapsed = useElapsedSeconds(stable.anchored ? stable.ts : null);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground"
    >
      <span className="sr-only">
        {stable.label}
        {stable.target ? `: ${stable.target}` : ""}
      </span>
      <ThinkingTrace className="shrink-0 text-foreground/75" />
      <span className="shrink-0 font-medium text-foreground/80">
        {stable.label}
      </span>
      {stable.target ? (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
          {stable.target}
        </span>
      ) : null}
      {elapsed > 0 ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/55">
          {formatElapsed(elapsed)}
        </span>
      ) : null}
    </div>
  );
}