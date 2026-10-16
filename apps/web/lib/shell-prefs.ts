/** Client-only layout prefs for the app shell (sidebar/panel). Non-sensitive. */

export interface ShellPrefs {
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  modelOverride: string;
}

const STORAGE_KEY = "buildx.shell";

/** An empty override means "use the server default" (`AGENT_MODEL`). */
const DEFAULTS: ShellPrefs = {
  sidebarCollapsed: false,
  panelOpen: false,
  modelOverride: "",
};

/**
 * Placeholder ids that earlier builds persisted. They are not real models, so a
 * stored override matching one is treated as "unset" instead of being sent.
 */
const LEGACY_INVALID_MODELS = new Set(["deepseek 0731"]);

export function loadShellPrefs(): ShellPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ShellPrefs>;
    const stored =
      typeof parsed.modelOverride === "string" ? parsed.modelOverride.trim() : "";
    return {
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      panelOpen: parsed.panelOpen === undefined ? false : Boolean(parsed.panelOpen),
      modelOverride:
        stored.length > 0 && !LEGACY_INVALID_MODELS.has(stored) ? stored : "",
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
