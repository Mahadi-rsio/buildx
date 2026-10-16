"use client";

import { Coins, Hash, ListChecks } from "lucide-react";
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

export function UsageDialog() {
  const { usageOpen, setUsageOpen, meta } = useShell();
  const tokens = meta.tokens ?? 0;
  const steps = meta.steps ?? 0;
  const usage = meta.workspace?.usage;
  const resetLabel =
    usage && Number.isFinite(usage.nextDhakaResetAt)
      ? new Date(usage.nextDhakaResetAt).toLocaleString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        })
      : "—";

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
              {usage ? `${usage.dailyRequestsUsed} / ${usage.dailyRequestsLimit}` : "—"}
            </span>
          </div>
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
