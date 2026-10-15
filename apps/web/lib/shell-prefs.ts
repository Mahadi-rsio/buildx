/** Client-only layout prefs for the app shell (sidebar/panel). Non-sensitive. */

export interface ShellPrefs {
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  modelOverride: string;
}

const STORAGE_KEY = "buildx.shell";

const DEFAULTS: ShellPrefs = {
  sidebarCollapsed: false,
  panelOpen: true,
  modelOverride: "",
};

export function loadShellPrefs(): ShellPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ShellPrefs>;
    return {
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      panelOpen: parsed.panelOpen === undefined ? true : Boolean(parsed.panelOpen),
      modelOverride:
        typeof parsed.modelOverride === "string" ? parsed.modelOverride : "",
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveShellPrefs(prefs: ShellPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full/blocked — layout prefs are best-effort.
  }
}
