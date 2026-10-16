"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, RotateCcw, Search, Settings2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useModels, type ModelOption } from "@/hooks/use-models";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 120;

export function ModelPicker({
  value,
  onChange,
  disabled,
  className,
  align = "start",
  onOpenSettings,
}: {
  /** Explicit override; empty string means "use the server default". */
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
  align?: "start" | "end";
  onOpenSettings?: () => void;
}) {
  const { models, defaultModel, loading } = useModels();
  const [query, setQuery] = useState("");

  const selected = value.trim();
  const effective = selected || defaultModel;
  const currentOption = models.find((m) => m.id === effective);
  const displayName = currentOption?.name || effective || "Select model";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q),
    );
  }, [models, query]);

  const visible = filtered.slice(0, MAX_RESULTS);

  function selectModel(id: string) {
    onChange(id);
    setQuery("");
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn(
              "h-8 min-w-0 gap-1.5 rounded-full border-border/80 bg-background/60 px-2.5 font-mono text-xs shadow-xs backdrop-blur-sm transition-all hover:border-foreground/30 hover:bg-muted/50",
              className,
            )}
          />
        }
      >
        <Sparkles className="size-3.5 shrink-0 text-primary/80" />
        <span className="min-w-0 truncate font-sans text-xs font-medium">
          {displayName}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground opacity-70" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align={align}
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border-border/80 bg-popover/95 p-1.5 shadow-xl backdrop-blur-md"
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Select model
          </span>
          {loading ? (
            <span className="text-[10px] text-muted-foreground">Loading…</span>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {models.length} available
            </span>
          )}
        </div>

        <div className="relative px-1 pb-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            aria-label="Search models"
            className="h-8 w-full rounded-lg border border-border/70 bg-background/60 pl-8 pr-2 text-xs outline-none transition focus:border-ring/60 focus:ring-2 focus:ring-ring/20"
          />
        </div>

        <DropdownMenuSeparator className="my-1 bg-border/60" />

        <div className="max-h-64 space-y-0.5 overflow-y-auto py-0.5">
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No models match “{query}”.
            </p>
          ) : (
            visible.map((m: ModelOption) => {
              const isSelected = m.id === effective;
              const isDefault = m.id === defaultModel;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => selectModel(m.id)}
                  className={cn(
                    "flex cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
                    isSelected
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-foreground hover:bg-muted/80",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate">{m.name}</span>
                      {isDefault ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                          default
                        </span>
                      ) : null}
                    </div>
                    <p
                      className={cn(
                        "mt-0.5 truncate font-mono text-[10px]",
                        isSelected ? "text-primary/70" : "text-muted-foreground",
                      )}
                    >
                      {m.description || m.id}
                    </p>
                  </div>
                  {isSelected ? (
                    <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  ) : null}
                </DropdownMenuItem>
              );
            })
          )}
          {filtered.length > visible.length ? (
            <p className="px-3 py-2 text-center font-mono text-[10px] text-muted-foreground/70">
              +{filtered.length - visible.length} more — refine your search
            </p>
          ) : null}
        </div>

        <DropdownMenuSeparator className="my-1 bg-border/60" />

        <div className="space-y-0.5">
          {selected ? (
            <DropdownMenuItem
              onClick={() => selectModel("")}
              className="cursor-pointer gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
              <span>Reset to server default</span>
            </DropdownMenuItem>
          ) : null}
          {onOpenSettings ? (
            <DropdownMenuItem
              onClick={onOpenSettings}
              className="cursor-pointer gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Settings2 className="size-3.5" />
              <span>Environment &amp; settings…</span>
            </DropdownMenuItem>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
