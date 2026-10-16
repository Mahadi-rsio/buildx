"use client";

import { type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { TopBar } from "@/components/shell/top-bar";
import { Sidebar, SidebarDrawer } from "@/components/shell/sidebar";
import { SettingsDialog } from "@/components/shell/settings-dialog";
import { UsageDialog } from "@/components/shell/usage-dialog";
import { ShellProvider, useShell } from "@/components/shell/shell-context";

function ShellLayout({ children }: { children: ReactNode }) {
  const { sidebarOpen, setSidebarOpen } = useShell();
  const isMobile = useIsMobile();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </div>
      {isMobile ? (
        <SidebarDrawer open={sidebarOpen} onOpenChange={setSidebarOpen} />
      ) : null}
      <SettingsDialog />
      <UsageDialog />
    </div>
  );
}

/**
 * App chrome: top bar, conversation sidebar, settings/usage dialogs.
 * Push run info into the top bar with `useShellMeta(...)` from the page.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ShellProvider>
      <ShellLayout>{children}</ShellLayout>
    </ShellProvider>
  );
}
