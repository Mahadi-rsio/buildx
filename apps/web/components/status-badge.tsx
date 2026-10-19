import type { RunStatus } from "@buildx/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STYLES: Record<RunStatus, string> = {
  queued: "border-border bg-secondary text-muted-foreground",
  running:
    "border-warning/25 bg-warning/10 text-warning dark:border-warning/25",
  waiting_input: "border-info/25 bg-info/10 text-info dark:border-info/25",
  completed:
    "border-success/25 bg-success/10 text-success dark:border-success/25",
  failed: "border-danger/25 bg-danger/10 text-danger dark:border-danger/25",
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
