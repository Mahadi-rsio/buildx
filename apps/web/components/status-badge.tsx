import type { RunStatus } from "@buildx/shared";

const STYLES: Record<RunStatus, string> = {
  queued: "bg-neutral-800 text-neutral-300 ring-neutral-700",
  running: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  waiting_input: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  completed: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  failed: "bg-red-500/15 text-red-300 ring-red-500/40",
  cancelled: "bg-neutral-800 text-neutral-400 ring-neutral-700",
};

const PULSE: RunStatus[] = ["queued", "running", "waiting_input"];

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STYLES[status]}`}
    >
      {PULSE.includes(status) ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {status.replace("_", " ")}
    </span>
  );
}
