"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, RotateCcw, Search, Sparkles } from "lucide-react";
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

const MAX_RESULTS = 500;

export function ModelPicker({
  value,
  onChange,
  disabled,
  className,
  align = "start",
}: {
  /** Explicit override; empty string means "use the server default". */
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
  align?: "start" | "end";
}) {
  const { models, defaultModel, loading } = useModels();
  const [query, setQuery] = useState("");

  const requested = value.trim();
  const selected = models.some((m) => m.id === requested) ? requested : "";
  const effective = selected || defaultModel;
  const currentOption = models.find((m) => m.id === effective);
  const displayName = currentOption?.name || selected || defaultModel || "Auto";

  // Drop stale persisted overrides (removed providers/aliases) once the real
  // catalog is known, so the composer never sends an unroutable model id.
  useEffect(() => {
    if (loading || models.length === 0) return;
    if (requested && !models.some((m) => m.id === requested)) onChange("");
  }, [loading, models, requested, onChange]);

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

  // Group the visible models by provider (LiteLLM / OpenRouter / ...) so the
  // dropdown reads as distinct catalogs.
  const groups = (() => {
    const map = new Map<string, { id: string; label: string; models: ModelOption[] }>();
    for (const m of visible) {
      const id = m.providerId || "other";
      const label = m.provider || "Other";
      const group = map.get(id);
      if (group) group.models.push(m);
      else map.set(id, { id, label, models: [m] });
    }
    return Array.from(map.values());
  })();

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
            variant="ghost"
            size="sm"
            disabled={disabled}
            title={effective || undefined}
            className={cn(
              "h-8 min-w-0 gap-1.5 rounded-full border-0 px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]",
              className,
            )}
          />
        }
      >
        <Sparkles className="size-3.5 shrink-0 text-[var(--text-faint)]" />
        <span className="min-w-0 truncate font-sans text-xs font-medium">
          {displayName}
        </span>
        <ChevronDown className="size-3 shrink-0 text-[var(--text-faint)]" />
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

        <div className="max-h-64 space-y-2 overflow-y-auto py-0.5">
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No models match “{query}”.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.id}>
                <p className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.models.map((m: ModelOption) => {
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
                            {m.provider ? (
                              <span className="shrink-0 rounded bg-border/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground/80">
                                {m.provider}
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
                  })}
                </div>
              </div>
            ))
          )}
          {filtered.length > visible.length ? (
            <p className="px-3 py-2 text-center font-mono text-[10px] text-muted-foreground/70">
              +{filtered.length - visible.length} more — refine your search
            </p>
          ) : null}
        </div>

        {selected ? (
          <>
            <DropdownMenuSeparator className="my-1 bg-border/60" />
            <DropdownMenuItem
              onClick={() => selectModel("")}
              className="cursor-pointer gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
              <span>Reset to server default</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
