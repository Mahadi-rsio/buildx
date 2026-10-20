"use client";

import { useEffect, useState } from "react";
import { Clock, Coins, Hash, Layers, ListChecks } from "lucide-react";
import { CONTEXT_WINDOW_OPTIONS } from "@buildx/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NumberTicker } from "@/components/ui/number-ticker";
import { StatusBadge } from "@/components/status-badge";
import { useShell } from "@/components/shell/shell-context";
import { useQuota } from "@/hooks/use-quota";

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}k`;
}

export function UsageDialog() {
  const {
    usageOpen,
    setUsageOpen,
    meta,
    contextWindowTokens,
    setContextWindowTokens,
  } = useShell();
  const quota = useQuota(usageOpen);
  const [now, setNow] = useState(() => Date.now());
  const tokens = meta.tokens ?? 0;
  const steps = meta.steps ?? 0;
  const usage = meta.workspace?.usage;
  const resetAt = quota.data?.resetAt ?? usage?.nextDhakaResetAt;
  const resetLabel =
    resetAt && Number.isFinite(resetAt)
      ? new Date(resetAt).toLocaleString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        })
      : "—";

  useEffect(() => {
    if (!usageOpen || !meta.startedAt || meta.endedAt) return;
    const kick = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [usageOpen, meta.startedAt, meta.endedAt]);

  const runtimeMs =
    meta.startedAt !== undefined
      ? Math.max(0, (meta.endedAt ?? now) - meta.startedAt)
      : undefined;
  const runtimeLabel =
    runtimeMs === undefined
      ? "—"
      : `${(runtimeMs / 60_000).toFixed(1)} min${meta.endedAt ? "" : " live"}`;

  const context = meta.context;
  const used = context?.assembledTokens;
  const limit =
    context?.contextLimit ?? meta.contextWindowTokens ?? contextWindowTokens;
  const percent =
    context?.utilizationPercent ??
    (used !== undefined && limit ? (used / limit) * 100 : undefined);

  return (
    <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            Live accounting for the open conversation, straight from run
            stats. Idle when no run is open.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-card/50 p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins className="size-3.5" />
              Tokens
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              <NumberTicker value={tokens} />
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              total across steps
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card/50 p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListChecks className="size-3.5" />
              Steps
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              <NumberTicker value={steps} />
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              agent loop iterations
            </p>
          </div>
        </div>

        <div className="space-y-2.5 rounded-xl border border-border p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Clock className="size-3.5" />
              Box runtime
            </span>
            <span className="font-mono text-foreground/80 tabular-nums">
              {runtimeLabel}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Layers className="size-3.5" />
              Context
            </span>
            <span className="font-mono text-foreground/80 tabular-nums">
              {used !== undefined
                ? `${formatTokens(used)} / ${formatTokens(limit)}`
                : formatTokens(limit)}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
            />
          </div>
          {context?.compactedCount ? (
            <p className="text-[11px] text-amber-600">
              Summarized {context.compactedCount} time
              {context.compactedCount === 1 ? "" : "s"} to stay under the
              window.
            </p>
          ) : null}
        </div>

        <div className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Context window</span>
            <span className="font-mono text-foreground/80">
              {formatTokens(contextWindowTokens)}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {CONTEXT_WINDOW_OPTIONS.map((option) => {
              const active = option === contextWindowTokens;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setContextWindowTokens(option)}
                  className={
                    active
                      ? "rounded-md border border-primary bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground"
                      : "rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  }
                >
                  {contextLabel(option)}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Older turns are summarized at ~90% of the window. Applies to the
            next run.
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Status</span>
            {meta.status === "idle" ? (
              <span className="text-foreground/80">No run open</span>
            ) : (
              <StatusBadge status={meta.status} />
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Model</span>
            <span className="truncate font-mono text-foreground/80">
              {meta.model ?? "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Run</span>
            <span className="inline-flex items-center gap-1 font-mono text-foreground/80">
              <Hash className="size-3" />
              {meta.runId ? meta.runId.slice(0, 10) : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">CPU-hours</span>
            <span className="font-mono text-foreground/80">
              {usage ? `${usage.cpuHoursUsed} / ${usage.cpuHoursLimit}` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Daily requests</span>
            <span className="font-mono text-foreground/80">
              {quota.data
                ? `${quota.data.used} / ${quota.data.limit}`
                : usage
                  ? `${usage.dailyRequestsUsed} / ${usage.dailyRequestsLimit}`
                  : "—"}
            </span>
          </div>
          {quota.data ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Remaining</span>
              <span className="font-mono text-foreground/80">
                {quota.data.remaining}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Dhaka reset</span>
            <span className="font-mono text-foreground/80">{resetLabel}</span>
          </div>
        </div>

        {meta.workspace?.message ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {meta.workspace.message}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Counts combine run usage and workspace quotas.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
