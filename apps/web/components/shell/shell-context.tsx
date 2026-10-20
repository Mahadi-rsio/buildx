"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RunStatus } from "@buildx/shared";
import {
  loadShellPrefs,
  saveShellPrefs,
  type ShellPrefs,
} from "@/lib/shell-prefs";
import { useIsMobile } from "@/hooks/use-mobile";
import type { WorkspaceRuntime } from "@/lib/types";

export type PanelTab = "files" | "changes";

/** Live run info pushed up by the active page so the top bar stays truthful. */
export interface ShellMeta {
  status: RunStatus | "idle";
  model?: string;
  runId?: string;
  workspaceId?: string;
  task?: string;
  steps?: number;
  tokens?: number;
  workspace?: WorkspaceRuntime;
}

const IDLE_META: ShellMeta = { status: "idle" };

interface ShellContextValue {
  meta: ShellMeta;
  setMeta: (meta: ShellMeta) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  panelOpen: boolean;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  /** True once the user explicitly toggled the panel (mobile drawer guard). */
  panelTouched: boolean;
  /** panelOpen on desktop; on mobile also requires an explicit open. */
  panelVisible: boolean;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  usageOpen: boolean;
  setUsageOpen: (open: boolean) => void;
  modelOverride: string;
  setModelOverride: (model: string) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) {
    throw new Error("useShell must be used inside <AppShell>");
  }
  return value;
}

/**
 * Push page-level run info into the shell (top bar status/model/usage).
 * setState happens after an await so it never runs synchronously in the effect.
 */
export function useShellMeta(meta: ShellMeta): void {
  const { setMeta } = useShell();
  const { status, model, runId, workspaceId, task, steps, tokens, workspace } = meta;

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setMeta({ status, model, runId, workspaceId, task, steps, tokens, workspace });
    })();
    return () => {
      alive = false;
    };
  }, [status, model, runId, workspaceId, task, steps, tokens, workspace, setMeta]);
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<ShellPrefs>({
    sidebarCollapsed: false,
    panelOpen: false,
    modelOverride: "",
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelTouched, setPanelTouched] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  const [usageOpen, setUsageOpen] = useState(false);
  const [meta, setMetaState] = useState<ShellMeta>(IDLE_META);
  const [ready, setReady] = useState(false);
  const isMobile = useIsMobile();

  // Load layout prefs after mount (localStorage is client-only).
  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setPrefs(loadShellPrefs());
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const updatePrefs = useCallback(
    (patch: Partial<ShellPrefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        if (ready) saveShellPrefs(next);
        return next;
      });
    },
    [ready],
  );

  const setMeta = useCallback((next: ShellMeta) => {
    setMetaState(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed });
  }, [prefs.sidebarCollapsed, updatePrefs]);

  const setPanelOpen = useCallback(
    (open: boolean) => {
      setPanelTouched(true);
      updatePrefs({ panelOpen: open });
    },
    [updatePrefs],
  );

  const togglePanel = useCallback(() => {
    setPanelTouched(true);
    updatePrefs({ panelOpen: !prefs.panelOpen });
  }, [prefs.panelOpen, updatePrefs]);

  const setModelOverride = useCallback(
    (model: string) => {
      updatePrefs({ modelOverride: model });
    },
    [updatePrefs],
  );

  const panelVisible = prefs.panelOpen && (!isMobile || panelTouched);

  const value = useMemo<ShellContextValue>(
    () => ({
      meta,
      setMeta,
      collapsed: prefs.sidebarCollapsed,
      toggleCollapsed,
      sidebarOpen,
      setSidebarOpen,
      panelOpen: prefs.panelOpen,
      togglePanel,
      setPanelOpen,
      panelTouched,
      panelVisible,
      panelTab,
      setPanelTab,
      usageOpen,
      setUsageOpen,
      modelOverride: prefs.modelOverride,
      setModelOverride,
    }),
    [
      meta,
      setMeta,
      prefs.sidebarCollapsed,
      prefs.panelOpen,
      prefs.modelOverride,
      toggleCollapsed,
      sidebarOpen,
      togglePanel,
      setPanelOpen,
      panelTouched,
      panelVisible,
      panelTab,
      usageOpen,
      setModelOverride,
    ],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
