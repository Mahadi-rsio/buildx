"use client";

import { type ReactNode } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  EmptyWorkspace,
  RightPanel,
  RightPanelDrawer,
  type WorkspaceData,
} from "@/components/shell/right-panel";
import { useShell } from "@/components/shell/shell-context";

/**
 * Main-area layout: the page's content plus the workspace panel.
 *
 * Desktop: resizable split (remounted when the panel toggles so sizes stay
 * sane). Mobile: content only; the panel lives in a right-side drawer.
 * Pass `workspace={null}` before a run exists — the panel then shows an
 * honest "no workspace yet" state instead of faking files.
 */
export function PanelSplit({
  workspace,
  children,
}: {
  workspace: WorkspaceData | null;
  children: ReactNode;
}) {
  const { panelVisible, setPanelOpen } = useShell();
  const isMobile = useIsMobile();
  const showSplit = panelVisible && !isMobile;

  if (isMobile) {
    return (
      <>
        <div className="flex h-full min-h-0 min-w-0 flex-col">{children}</div>
        {workspace ? (
          <RightPanelDrawer
            open={panelVisible}
            onOpenChange={(open) => {
              if (!open) setPanelOpen(false);
            }}
            {...workspace}
          />
        ) : null}
      </>
    );
  }

  return (
    <ResizablePanelGroup
      key={showSplit ? "split" : "full"}
      orientation="horizontal"
      className="h-full w-full"
    >
      <ResizablePanel
        defaultSize={showSplit ? "64" : "100"}
        minSize="30"
        className="min-w-0"
      >
        {children}
      </ResizablePanel>
      {showSplit ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="36" minSize="20" className="min-w-0">
            {workspace ? <RightPanel {...workspace} /> : <EmptyWorkspace />}
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
