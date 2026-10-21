"use client";

import { useState } from "react";
import { Eye, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SkillView } from "@/hooks/use-skills";
import { cn } from "@/lib/utils";

function sourceKindLabel(kind: SkillView["sourceKind"]): string {
  if (kind === "github") return "GitHub";
  if (kind === "url") return "URL";
  return "Archive";
}

function shorten(value: string, max = 28): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function SkillCard({
  skill,
  busy,
  onToggle,
  onView,
  onDelete,
}: {
  skill: SkillView;
  busy: boolean;
  onToggle: () => void;
  onView: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const disabled = busy || deleting;

  async function confirmDelete() {
    setDeleting(true);
    try {
      await onDelete();
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <li
      className={cn(
        "rounded-xl border border-border bg-card p-3 transition",
        disabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {sourceKindLabel(skill.sourceKind)}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {skill.scope}
            </Badge>
            <Badge
              variant={skill.enabled ? "secondary" : "outline"}
              className="text-[10px]"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  skill.enabled
                    ? "bg-[var(--ansi-green)]"
                    : "bg-[var(--text-faint)]",
                )}
              />
              {skill.enabled ? "Active" : "Off"}
            </Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {skill.description}
          </p>
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-faint)]"
            title={skill.source}
          >
            {skill.source}
          </p>
          <p
            className="mt-1 truncate font-mono text-[10px] text-[var(--text-faint)]"
            title={`${skill.resolvedRef} · ${skill.digest}`}
          >
            {shorten(skill.resolvedRef)} · {skill.digest.slice(0, 8)} ·{" "}
            {skill.fileCount} file
            {skill.fileCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`View ${skill.name}`}
            disabled={disabled}
            onClick={onView}
          >
            <Eye className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete ${skill.name}`}
            disabled={disabled}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={skill.enabled}
            disabled={disabled}
            onChange={onToggle}
          />
          Enabled
        </label>
        {busy ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : null}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {skill.name}?</DialogTitle>
            <DialogDescription>
              This removes the skill from your account and from future runs. It
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Delete skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
