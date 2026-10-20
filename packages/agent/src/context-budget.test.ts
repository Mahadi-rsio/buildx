import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createContextBudget,
  estimateMessageTokens,
  estimateRequestTokens,
} from "./context-budget";

test("estimateRequestTokens counts system, messages and tool schemas", () => {
  const messages = [
    { role: "user" as const, content: "hello world this is a test message" },
  ];
  const tools = {
    read_file: {
      description: "Read a file from the workspace",
      inputSchema: z.object({ path: z.string() }),
    },
  };
  const estimate = estimateRequestTokens({
    system: "You are a helpful assistant.",
    messages,
    tools,
  });
  assert.ok(Number.isInteger(estimate));
  assert.ok(estimate > 1, "estimate should exceed the floor");
  // System + message content is ~60 chars => ~15 tokens; tool schema adds more.
  assert.ok(estimate >= 15, `expected >=15 tokens, got ${estimate}`);
});

test("estimateRequestTokens tolerates missing system and tools", () => {
  const estimate = estimateRequestTokens({ messages: [] });
  assert.equal(estimate, 1, "empty request floors at 1 token");
  const withMessage = estimateRequestTokens({
    messages: [{ role: "user" as const, content: "hi" }],
  });
  assert.ok(withMessage >= 2);
});

test("estimateMessageTokens grows with content and floors at 1", () => {
  assert.equal(estimateMessageTokens([]), 0);
  assert.equal(
    estimateMessageTokens([{ role: "user" as const, content: "a" }]),
    3, // 1 content char + 8 overhead => 9 chars => ceil(9/4)
  );
  const longer = estimateMessageTokens([
    { role: "user" as const, content: "x".repeat(100) },
  ]);
  assert.ok(longer > 10);
});

test("compactedCount increments once per forced compaction", async () => {
  const budget = createContextBudget({ limitTokens: 100 });
  const longMessages = [
    { role: "user" as const, content: "y".repeat(50_000) },
    { role: "assistant" as const, content: "z".repeat(50_000) },
  ];
  // Over budget: forces the summarize tool.
  const forced = await budget.prepareStep({ messages: longMessages });
  assert.ok(forced && forced.toolChoice, "expected a forced toolChoice");
  assert.equal(budget.compactedCount, 0);
  const beforeTokens = budget.estimatedTokens();
  assert.ok(beforeTokens > 1000, "pre-compaction transcript is large");

  // Simulate the model producing a summary, then the next prepareStep
  // replaces the transcript with the compacted form.
  await budget.summarizeTool.execute!(undefined as never, {} as never);
  const compacted = await budget.prepareStep({ messages: longMessages });
  assert.ok(compacted && compacted.messages, "expected compacted messages");
  assert.equal(budget.compactedCount, 1);
  // The compacted replacement is far smaller than the original transcript.
  assert.ok(
    budget.estimatedTokens() < beforeTokens / 10,
    `expected compaction to shrink the estimate, got ${budget.estimatedTokens()}`,
  );
});

test("budget does not compact under the limit", async () => {
  const budget = createContextBudget({ limitTokens: 1_000_000 });
  const result = await budget.prepareStep({
    messages: [{ role: "user" as const, content: "tiny" }],
  });
  assert.equal(result, undefined);
  assert.equal(budget.compactedCount, 0);
});