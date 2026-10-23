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
    3,
  );
  const longer = estimateMessageTokens([
    { role: "user" as const, content: "x".repeat(100) },
  ]);
  assert.ok(longer > 10);
});

test("compactedCount increments once per forced compaction and keeps recent turns", async () => {
  const budget = createContextBudget({ limitTokens: 100 });
  const longMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${index}: ${"x".repeat(10_000)}`,
  }));
  const forced = await budget.prepareStep({
    system: "A large stable system prompt",
    messages: longMessages,
    tools: {
      read_file: {
        description: "Read files",
        inputSchema: z.object({ path: z.string() }),
      },
    },
  });
  assert.ok(forced && forced.toolChoice, "expected a forced toolChoice");
  assert.equal(budget.compactedCount, 0);
  const beforeTokens = budget.estimatedTokens();
  assert.ok(beforeTokens > 1000, "pre-compaction request is large");

  await budget.summarizeTool.execute!(undefined as never, {} as never);
  const compacted = await budget.prepareStep({
    system: "A large stable system prompt",
    messages: longMessages,
    tools: {
      read_file: {
        description: "Read files",
        inputSchema: z.object({ path: z.string() }),
      },
    },
  });
  assert.ok(compacted && compacted.messages, "expected compacted messages");
  assert.equal(budget.compactedCount, 1);
  assert.equal(compacted.messages.length, 9, "summary plus recent tail");
  assert.match(String(compacted.messages.at(-1)?.content), /^11:/);
  assert.ok(
    budget.estimatedTokens() < beforeTokens,
    `expected compaction to shrink the estimate, got ${budget.estimatedTokens()}`,
  );
});

test("system and tool definitions can trigger compaction even with a small transcript", async () => {
  const budget = createContextBudget({ limitTokens: 100 });
  const result = await budget.prepareStep({
    system: "s".repeat(300),
    messages: [{ role: "user" as const, content: "tiny" }],
    tools: {
      huge_tool: {
        description: "d".repeat(300),
        inputSchema: z.object({ value: z.string().describe("v".repeat(300)) }),
      },
    },
  });
  assert.ok(result?.toolChoice, "assembled request should trigger compaction");
});

test("budget does not compact under the limit", async () => {
  const budget = createContextBudget({ limitTokens: 1_000_000 });
  const result = await budget.prepareStep({
    messages: [{ role: "user" as const, content: "tiny" }],
  });
  assert.equal(result, undefined);
  assert.equal(budget.compactedCount, 0);
});
