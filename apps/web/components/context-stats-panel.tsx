"use client";

import { Layers, Shrink } from "lucide-react";
import type { ContextUsagePayload } from "@buildx/shared";
import { getModelContextWindow } from "@buildx/shared";
import { cn } from "@/lib/utils";

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * Live context-window utilization for the open run. When the agent has not yet
 * emitted a `context` payload (e.g. a freshly loaded finished run), falls back
 * to the model's cataloged window so the panel still shows the ceiling.
 */
export function ContextStatsPanel({
  model,
  context,
  contextWindowTokens,
  className,
}: {
  model: string | undefined;
  context?: ContextUsagePayload | undefined;
  /** Selected run window, used before the first usage payload arrives. */
  contextWindowTokens?: number;
  className?: string;
}) {
  const contextLimit =
    context?.contextLimit ??
    contextWindowTokens ??
    getModelContextWindow(model) ??
    undefined;
  const assembled = context?.assembledTokens;
  const percent = context?.utilizationPercent;

  if (contextLimit === undefined && assembled === undefined) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-border/80 bg-card/40 px-2.5 py-1.5",
        className,
      )}
    >
      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex items-center gap-2">
        <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
            aria-hidden
          />
        </div>
        <span className="text-xs tabular-nums text-foreground">
          {percent !== undefined
            ? `${Math.round(percent)}%`
            : assembled !== undefined
              ? formatTokens(assembled)
              : "—"}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          of {formatTokens(contextLimit)}
        </span>
        {assembled !== undefined && context?.estimated ? (
          <span className="text-[10px] text-muted-foreground/70">est.</span>
        ) : null}
      </div>
      {context?.compactedCount !== undefined && context.compactedCount > 0 ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
          <Shrink className="size-3" />
          compacted ×{context.compactedCount}
        </span>
      ) : null}
    </div>
  );
}