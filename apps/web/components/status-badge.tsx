import type { RunStatus } from "@buildx/shared";
import { cn } from "@/lib/utils";

const STYLES: Record<RunStatus, string> = {
  queued: "text-[var(--text-faint)]",
  running: "text-[var(--text-muted)]",
  waiting_input: "text-[var(--text-muted)]",
  completed: "text-[var(--text-faint)]",
  failed: "text-[var(--text)]",
  cancelled: "text-[var(--text-faint)]",
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
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] font-medium capitalize",
        STYLES[status],
        className,
      )}
    >
      {PULSE.includes(status) ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      ) : null}
      {status.replace("_", " ")}
    </span>
  );
}
