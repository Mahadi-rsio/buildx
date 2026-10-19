import Anser from "anser";

/**
 * Render terminal text with ANSI escapes as HTML using anser's named classes
 * (`.ansi-*-fg` etc — see globals.css). Escape the text *before* converting so
 * user/agent output can never inject markup, while anser's own `<span>` tags
 * survive. Inject the result with `dangerouslySetInnerHTML`.
 */
export function ansiToHtml(text: string): string {
  if (!text) return "";
  return Anser.ansiToHtml(Anser.escapeForHtml(text), { use_classes: true });
}

/** Strip ANSI escapes and return plain text (for copy). */
export function ansiToText(text: string): string {
  if (!text) return "";
  return Anser.ansiToText(text);
}

/** True when the string carries ANSI escape sequences. */
export function hasAnsi(text: string): boolean {
  return text.includes("\u001b") || text.includes("\u009b");
}