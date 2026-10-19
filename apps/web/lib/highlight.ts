import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
} from "shiki";

type LazyHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

let highlighterPromise: Promise<LazyHighlighter> | null = null;
const loadedLangs = new Set<BundledLanguage>();

const LIGHT_THEME = "github-light-default" as const;
const DARK_THEME = "github-dark-default" as const;

/** Lazily boot one highlighter and reuse it across calls. */
function getHighlighter(): Promise<LazyHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    });
  }
  return highlighterPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Synchronously-safe HTML wrapper for plain text; shiki is loaded lazily on
 * the first real code request so the thread shell never pays for it.
 */
export function plainCodeHtml(code: string): string {
  return `<pre class="shiki planet"><code>${escapeHtml(code)}</code></pre>`;
}

/**
 * Highlight `code` with `lang` using shiki's dual-theme output: every token
 * carries both `--shiki-light` and `--shiki-dark` values and globals.css picks
 * the active one from the `.dark` class, so the block re-colors with the theme
 * without re-running the highlighter. Falls back to an escaped plain block when
 * the language is unknown or shiki cannot load. Render with
 * `dangerouslySetInnerHTML`.
 */
export async function highlightCode(
  code: string,
  lang: string,
): Promise<string> {
  const normalized = (lang || "text").toLowerCase().trim();
  if (normalized === "text" || normalized === "") return plainCodeHtml(code);
  try {
    const highlighter = await getHighlighter();
    const bundled = normalized as BundledLanguage;
    if (!loadedLangs.has(bundled)) {
      try {
        await highlighter.loadLanguage(bundled);
        loadedLangs.add(bundled);
      } catch {
        return plainCodeHtml(code);
      }
    }
    return highlighter.codeToHtml(code, {
      lang: bundled,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    });
  } catch {
    return plainCodeHtml(code);
  }
}
