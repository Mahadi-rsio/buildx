export type DiffRow = { type: "ctx" | "add" | "del"; text: string };

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

/**
 * Line-based diff via longest-common-subsequence. Falls back to a truthful
 * "removed all / added all" pair when the inputs are too large to diff
 * cheaply, so caller output is never fabricated.
 */
export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];

  // Keep DP bounded; edit snippets are small in practice.
  if (n * m > 100_000) {
    const rows: DiffRow[] = [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
    return rows;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    rows.push({ type: "add", text: b[j] });
    j++;
  }
  return rows;
}