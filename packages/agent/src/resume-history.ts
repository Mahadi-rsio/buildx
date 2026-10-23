import type { ConversationTurn } from "@buildx/shared";

/**
 * Merge checkpointed progress with caller-supplied conversation history.
 * Checkpoints may contain the interrupted task and its partial response while
 * the caller's history may be an older prefix or a newer full conversation.
 * Keep the longer version when one is a prefix of the other; otherwise merge
 * the largest exact overlap so resume never silently drops checkpoint context.
 */
export function mergeResumeHistory(
  checkpointHistory: ConversationTurn[] | undefined,
  suppliedHistory: ConversationTurn[] | undefined,
): ConversationTurn[] {
  const checkpoint = checkpointHistory ?? [];
  const supplied = suppliedHistory ?? [];
  if (checkpoint.length === 0) return supplied;
  if (supplied.length === 0) return checkpoint;

  const sameTurn = (a: ConversationTurn, b: ConversationTurn) =>
    a.role === b.role && a.content === b.content;
  const isPrefix = (prefix: ConversationTurn[], full: ConversationTurn[]) =>
    prefix.length <= full.length &&
    prefix.every((turn, index) => sameTurn(turn, full[index]));

  if (isPrefix(checkpoint, supplied)) return supplied;
  if (isPrefix(supplied, checkpoint)) return checkpoint;

  const maxOverlap = Math.min(checkpoint.length, supplied.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const matches = checkpoint
      .slice(-overlap)
      .every((turn, index) => sameTurn(turn, supplied[index]));
    if (matches) return [...checkpoint, ...supplied.slice(overlap)];
  }

  // There is no safe way to infer a shared boundary. Preserve checkpoint
  // progress first, then append the new supplied turns rather than discard it.
  return [...checkpoint, ...supplied];
}
