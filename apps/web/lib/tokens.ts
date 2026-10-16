import type { RunTaskUsage } from "@buildx/agent";

/** Token accounting shown under a chat message. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when the numbers are client-side approximations, not provider usage. */
  estimated: boolean;
}

/**
 * Rough token estimate (~4 chars/token, the common English heuristic). Used to
 * show *live* usage while a run streams; replaced by real provider usage from
 * `run.stats.usage` once the run finishes.
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Build a message footer from real usage when available, else estimates. */
export function buildTokenUsage(args: {
  task: string;
  outputText: string;
  usage?: RunTaskUsage;
}): TokenUsage {
  const actual =
    typeof args.usage?.totalTokens === "number" &&
    typeof args.usage.inputTokens === "number" &&
    typeof args.usage.outputTokens === "number";

  if (actual) {
    return {
      inputTokens: args.usage?.inputTokens ?? 0,
      outputTokens: args.usage?.outputTokens ?? 0,
      totalTokens: args.usage?.totalTokens ?? 0,
      estimated: false,
    };
  }

  const inputTokens = estimateTokens(args.task);
  const outputTokens = estimateTokens(args.outputText);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}

/** `1234` → `1.2k`; small values stay exact. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
