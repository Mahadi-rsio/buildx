"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Ellipsis,
  Pin,
  PinOff,
  Plug,
  Plus,
  Search,
  Trash2,
  Pencil,
  X,
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
      ? "bg-[var(--text-faint)]"
      : status === "failed" || status === "cancelled"
        ? "bg-[var(--text)]"
        : status === "running" || status === "queued" || status === "waiting_input"
          ? "bg-[var(--text-muted)] animate-pulse motion-reduce:animate-none"
          : "bg-[var(--text-faint)]";
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
  const searchRef = useRef<HTMLInputElement>(null);
  const { setUsageOpen } = useShell();

  const { pinned, groups } = useMemo(
    () => prepareRunList(runs, prefs, query),
    [runs, prefs, query],
  );
  const visibleCount =
    pinned.length + groups.reduce((total, group) => total + group.items.length, 0);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function renderItem(run: RunListItem) {
    const active = pathname === `/runs/${run.id}`;
    return (
      <li key={run.id}>
        <div
          className={cn(
            "group relative flex items-center rounded-lg transition",
            active
              ? "bg-[var(--surface)] shadow-[inset_0_0_0_1px_var(--border)]"
              : "hover:bg-muted/40",
          )}
        >
          {active ? (
            <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--text)]" />
          ) : null}
          <Link
            href={`/runs/${run.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-8"
          >
            <StatusDot status={run.status} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                active
                  ? "font-medium text-foreground"
                  : "text-foreground/80 group-hover:text-foreground",
              )}
            >
              {run.title}
            </span>
            <span
              className={cn(
                "shrink-0 font-mono text-[10px] text-muted-foreground transition",
                active
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100",
              )}
            >
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
      <div className="px-3 pb-2 pt-3">
        <Button
          type="button"
          size="sm"
          className="h-9 w-full justify-center gap-2 rounded-lg text-xs"
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
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-8 pl-8 pr-8 text-xs"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-[var(--surface)] px-1 py-0.5 font-mono text-[9px] text-muted-foreground sm:inline">
              ⌘K
            </kbd>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pb-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Chats
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {visibleCount}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2.5">
        {loading ? (
          <div className="space-y-1.5 px-1 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <p className="px-2 py-3 text-xs text-[var(--text-muted)]">{error}</p>
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
                <h3 className="flex items-center gap-1 px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <Pin className="size-2.5" />
                  Pinned
                  <span className="ml-auto font-mono tabular-nums text-muted-foreground/60">
                    {pinned.length}
                  </span>
                </h3>
                <ul className="space-y-0.5">{pinned.map(renderItem)}</ul>
              </section>
            ) : null}
            {groups.map((group) => (
              <section key={group.id}>
                <h3 className="flex items-center px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                  <span className="ml-auto font-mono tabular-nums text-muted-foreground/60">
                    {group.items.length}
                  </span>
                </h3>
                <ul className="space-y-0.5">{group.items.map(renderItem)}</ul>
              </section>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="border-t border-border/70 p-2.5">
        <div className="grid grid-cols-2 gap-2">
          <Link
            href="/mcp"
            onClick={onNavigate}
            aria-current={pathname === "/mcp" ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-2 rounded-lg border px-2.5 text-xs transition",
              pathname === "/mcp"
                ? "border-border bg-[var(--surface)] text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:bg-[var(--surface)] hover:text-foreground",
            )}
          >
            <Plug className="size-3.5" />
            <span>MCP</span>
          </Link>
          <button
            type="button"
            onClick={() => {
              setUsageOpen(true);
              onNavigate?.();
            }}
            className="flex h-9 items-center gap-2 rounded-lg border border-transparent px-2.5 text-xs text-muted-foreground transition hover:border-border hover:bg-[var(--surface)] hover:text-foreground"
          >
            <BarChart3 className="size-3.5" />
            <span>Usage</span>
          </button>
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
        collapsed ? "w-0 border-r-0" : "w-[17rem]",
      )}
    >
      <div
        className={cn("h-full w-[17rem]", collapsed && "pointer-events-none")}
      >
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
