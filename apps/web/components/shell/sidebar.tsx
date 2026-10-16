"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Ellipsis,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Trash2,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useRuns } from "@/hooks/use-runs";
import { useConversationPrefs } from "@/hooks/use-conversation-prefs";
import { prepareRunList, type RunListItem } from "@/lib/group-runs";
import { formatAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useShell } from "@/components/shell/shell-context";

function StatusDot({ status }: { status: RunListItem["status"] }) {
  const tone =
    status === "completed"
      ? "bg-emerald-400"
      : status === "failed" || status === "cancelled"
        ? "bg-red-400"
        : status === "running" || status === "queued" || status === "waiting_input"
          ? "bg-amber-400 animate-pulse motion-reduce:animate-none"
          : "bg-muted-foreground/50";
  return <span className={cn("size-1.5 shrink-0 rounded-full", tone)} />;
}

function RenameDialog({
  run,
  open,
  onClose,
  onSave,
}: {
  run: RunListItem | null;
  open: boolean;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open || !run) return;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setDraft(run.title);
    })();
    return () => {
      alive = false;
    };
  }, [open, run]);

  if (!run) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            Stored locally in this browser — the run itself keeps its original
            task text.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(draft);
            onClose();
          }}
          className="space-y-3"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            aria-label="Conversation title"
            className="h-9"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={draft.trim().length === 0}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SidebarBody({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { runs, loading, error } = useRuns();
  const { prefs, rename, togglePin, hide } = useConversationPrefs();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<RunListItem | null>(null);
  const { setSettingsOpen, setUsageOpen } = useShell();

  const { pinned, groups } = useMemo(
    () => prepareRunList(runs, prefs, query),
    [runs, prefs, query],
  );

  function renderItem(run: RunListItem) {
    const active = pathname === `/runs/${run.id}`;
    return (
      <li key={run.id}>
        <div
          className={cn(
            "group relative flex items-center rounded-lg transition",
            active ? "bg-muted/70" : "hover:bg-muted/40",
          )}
        >
          <Link
            href={`/runs/${run.id}`}
            onClick={onNavigate}
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5"
          >
            <StatusDot status={run.status} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85 group-hover:text-foreground">
              {run.title}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
              {formatAgo(run.updatedAt)}
            </span>
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${run.title}`}
                  className="absolute right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                />
              }
            >
              <Ellipsis className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem
                onClick={() => setRenaming(run)}
                className="text-xs"
              >
                <Pencil className="size-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => togglePin(run.id)}
                className="text-xs"
              >
                {run.pinned ? (
                  <>
                    <PinOff className="size-3.5" />
                    Unpin
                  </>
                ) : (
                  <>
                    <Pin className="size-3.5" />
                    Pin
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => hide(run.id)}
                className="text-xs"
              >
                <Trash2 className="size-3.5" />
                Remove from list
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  }

  const empty = !loading && !error && pinned.length === 0 && groups.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Button
          type="button"
          size="sm"
          className="flex-1 justify-start gap-1.5"
          render={<Link href="/" />}
          nativeButton={false}
          onClick={onNavigate}
        >
          <Plus className="size-3.5" />
          New chat
        </Button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {loading ? (
          <div className="space-y-1.5 px-1 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <p className="px-2 py-3 text-xs text-red-400">{error}</p>
        ) : empty ? (
          <div className="px-2 py-6 text-center">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {query
                ? "No conversations match your search."
                : "No conversations yet. Start a chat to open one."}
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-1 pb-4">
            {pinned.length > 0 ? (
              <section>
                <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Pinned
                </h3>
                <ul className="space-y-0.5">{pinned.map(renderItem)}</ul>
              </section>
            ) : null}
            {groups.map((group) => (
              <section key={group.id}>
                <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="space-y-0.5">{group.items.map(renderItem)}</ul>
              </section>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="border-t border-border/80 p-2">
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setUsageOpen(true);
              onNavigate?.();
            }}
          >
            <BarChart3 className="size-3.5" />
            <span>Usage</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setSettingsOpen(true);
              onNavigate?.();
            }}
          >
            <Settings2 className="size-3.5" />
            <span>Settings</span>
          </Button>
        </div>
      </div>

      <RenameDialog
        run={renaming}
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        onSave={(title) => {
          if (renaming) rename(renaming.id, title);
        }}
      />
    </div>
  );
}

/** Desktop sidebar (collapsible via shell state). */
export function Sidebar() {
  const { collapsed } = useShell();
  return (
    <aside
      aria-label="Conversations"
      className={cn(
        "hidden shrink-0 overflow-hidden border-r border-border bg-sidebar/60 transition-[width] duration-200 md:block",
        collapsed ? "w-0 border-r-0" : "w-64",
      )}
    >
      <div className={cn("h-full w-64", collapsed && "pointer-events-none")}>
        <SidebarBody />
      </div>
    </aside>
  );
}

/** Mobile drawer sidebar. */
export function SidebarDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-72 p-0 sm:max-w-xs"
        showCloseButton
      >
        <SheetTitle className="sr-only">Conversations</SheetTitle>
        <SidebarBody onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
