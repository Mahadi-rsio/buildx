"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const subscribe = () => () => {};

function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

/**
 * Three-way theme switch with a sliding selection. `next-themes` persists the
 * choice in localStorage and applies the class before paint, so there is no
 * light flash on reload.
 */
export function ThemeSwitch({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const active = mounted ? (theme ?? "system") : "system";
  const index = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === active),
  );

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn(
        "relative grid grid-cols-3 rounded-xl border border-border bg-muted/40 p-1",
        compact ? "h-9" : "h-10",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-lg bg-surface shadow-sm ring-1 ring-border transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const selected = option.value === active;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={cn(
              "relative z-10 inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors",
              compact ? "px-1" : "px-2",
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={compact ? "size-3.5" : "size-4"} />
            <span className={compact ? "sr-only" : "hidden sm:inline"}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
