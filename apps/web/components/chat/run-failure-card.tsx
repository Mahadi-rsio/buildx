"use client";

import { AlertTriangle, CreditCard, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  dailyLimitResetLabel,
  isDailyLimitMessage,
} from "@/lib/quota-errors";

export function RunFailureCard({
  reason,
  resetAt,
  onRetry,
  onAddCredit,
}: {
  reason: string;
  resetAt?: number;
  onRetry?: () => void;
  onAddCredit: () => void;
}) {
  const limit = isDailyLimitMessage(reason);

  return (
    <div className="rounded-xl border border-border bg-surface/60 p-3 sm:p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          <AlertTriangle className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {limit ? "Daily limit reached" : "This run failed"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {limit
              ? `You have used today's AI requests. The limit resets ${dailyLimitResetLabel(resetAt)}.`
              : reason}
          </p>
          {limit && reason ? (
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
              {reason}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {limit ? (
              <Button type="button" size="sm" className="h-8" onClick={onAddCredit}>
                <CreditCard className="size-3.5" />
                Add credit
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                type="button"
                size="sm"
                variant={limit ? "outline" : "default"}
                className="h-8"
                onClick={onRetry}
              >
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
