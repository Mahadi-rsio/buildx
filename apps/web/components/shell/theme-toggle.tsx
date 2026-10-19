"use client";

import { useEffect, useRef } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/**
 * Light/dark switch for the top bar. Both icons are rendered and toggled with
 * CSS (`dark:` variant) so the control is correct before hydration. The
 * theme-aware label is applied in an effect (DOM only, no setState) to avoid a
 * server/client hydration mismatch, since `resolvedTheme` is unknown during SSR.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const ref = useRef<HTMLButtonElement>(null);
  const isDark = resolvedTheme === "dark";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const label = isDark ? "Switch to light theme" : "Switch to dark theme";
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
  }, [isDark]);

  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-touch"
      aria-label="Toggle theme"
      title="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <Sun className="hidden size-4 dark:block" />
      <Moon className="size-4 dark:hidden" />
    </Button>
  );
}
