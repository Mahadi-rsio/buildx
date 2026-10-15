import type { RunStatus } from "@buildx/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STYLES: Record<RunStatus, string> = {
  queued: "border-border bg-secondary text-muted-foreground",
  running:
    "border-amber-500/30 bg-amber-500/10 text-amber-300 dark:border-amber-500/30",
  waiting_input:
    "border-sky-500/30 bg-sky-500/10 text-sky-300 dark:border-sky-500/30",
  completed:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 dark:border-emerald-500/30",
  failed:
    "border-red-500/30 bg-red-500/10 text-red-300 dark:border-red-500/30",
  cancelled: "border-border bg-secondary text-muted-foreground",
};

const PULSE: RunStatus[] = ["queued", "running", "waiting_input"];

export function StatusBadge({
  status,
  className,
}: {
  status: RunStatus;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium capitalize", STYLES[status], className)}
    >
      {PULSE.includes(status) ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {status.replace("_", " ")}
    </Badge>
  );
}
