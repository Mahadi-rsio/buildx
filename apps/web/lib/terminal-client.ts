import type { TerminalRecord } from "./terminal";

export const TERMINAL_HISTORY_LIMIT = 50;

export function terminalHistoryKey(workspaceId: string): string {
  return `buildx.terminal.history.${workspaceId}`;
}

export function takeNdjsonRecords(buffer: string): {
  records: TerminalRecord[];
  rest: string;
} {
  const records: TerminalRecord[] = [];
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        records.push(parsed as TerminalRecord);
      }
    } catch {
      // Ignore malformed frames rather than dropping later valid output.
    }
  }
  return { records, rest };
}

export function readTerminalHistory(workspaceId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(terminalHistoryKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function pushTerminalHistory(
  workspaceId: string,
  command: string,
  current: readonly string[],
): string[] {
  const next = [command, ...current.filter((item) => item !== command)].slice(
    0,
    TERMINAL_HISTORY_LIMIT,
  );
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(
        terminalHistoryKey(workspaceId),
        JSON.stringify(next),
      );
    } catch {
      // Storage can be unavailable in private mode; in-memory history still works.
    }
  }
  return next;
}

export function terminalCellSize(
  width: number,
  height: number,
): { cols: number; rows: number } {
  const cols = Math.max(20, Math.min(500, Math.floor(width / 7.2)));
  const rows = Math.max(5, Math.min(200, Math.floor(height / 18)));
  return { cols, rows };
}
