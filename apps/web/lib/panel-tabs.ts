/** Tabs available in the workspace side panel. */
export const PANEL_TABS = ["files", "changes", "terminal", "git"] as const;

export type PanelTab = (typeof PANEL_TABS)[number];

export const DEFAULT_PANEL_TAB: PanelTab = "files";

export function isPanelTab(value: unknown): value is PanelTab {
  return typeof value === "string" && (PANEL_TABS as readonly string[]).includes(value);
}

/** Coerce external tab values (URLs, stored state) to a real tab. */
export function toPanelTab(value: unknown): PanelTab {
  return isPanelTab(value) ? value : DEFAULT_PANEL_TAB;
}
