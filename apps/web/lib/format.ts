/** Compact relative timestamp for list rows. */
export function formatAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Wall-clock time with seconds, for event rows. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Human-readable byte count: "1.2 KB", "3.4 MB", or "0 B" for empty. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit - 1]}`;
}

/** Bounded line count label: "142 lines" or "800+ lines" past `ceiling`. */
export function formatLines(count: number, ceiling = 1000): string {
  const safe = Number.isFinite(count) ? Math.max(0, count) : 0;
  return safe > ceiling ? `${ceiling}+` : `${safe}`;
}
