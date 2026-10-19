import {
  createCssVariablesTheme,
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
} from "shiki";

type LazyHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

let highlighterPromise: Promise<LazyHighlighter> | null = null;
const loadedLangs = new Set<BundledLanguage>();

/**
 * Grayscale theme backed by the design-system CSS variables. Shiki writes
 * `color: var(--shiki-token-*)` inline and globals.css maps those variables to
 * `--text` / `--text-muted` / `--text-faint`, so highlighting stays monochrome
 * in both themes.
 */
const MONO_THEME = createCssVariablesTheme({
  name: "buildx-mono",
  variablePrefix: "--shiki-",
});

/** Lazily boot one highlighter and reuse it across calls. */
function getHighlighter(): Promise<LazyHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [MONO_THEME],
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
 * Highlight `code` with `lang`. Falls back to an escaped plain block when the
 * language is unknown or shiki cannot load. Returns shiki HTML (a
 * `<pre class="shiki">`) — render with `dangerouslySetInnerHTML`.
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
      theme: "buildx-mono",
    });
  } catch {
    return plainCodeHtml(code);
  }
}
