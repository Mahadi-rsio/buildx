import assert from "node:assert/strict";
import { test } from "node:test";
import { getModelContextWindow } from "./model-context";

test("returns the cataloged window for known model ids", () => {
  assert.equal(getModelContextWindow("claude-3-5-sonnet-20241022"), 200_000);
  assert.equal(getModelContextWindow("claude-sonnet-4-5"), 200_000);
  assert.equal(getModelContextWindow("o3-mini"), 200_000);
  assert.equal(getModelContextWindow("gpt-4o"), 128_000);
  assert.equal(getModelContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(getModelContextWindow("gpt-4.1-mini"), 1_000_000);
  assert.equal(getModelContextWindow("gemini-2.5-pro"), 1_000_000);
  assert.equal(getModelContextWindow("deepseek-v3"), 128_000);
  assert.equal(getModelContextWindow("grok-3"), 131_072);
});

test("strips known provider prefixes before matching", () => {
  assert.equal(getModelContextWindow("openai/gpt-4o"), 128_000);
  assert.equal(getModelContextWindow("anthropic/claude-sonnet-4-5"), 200_000);
  assert.equal(getModelContextWindow("groq/llama-3.3-70b-versatile"), 128_000);
  assert.equal(getModelContextWindow("litellm/deepseek-v3"), 128_000);
  assert.equal(getModelContextWindow("google/gemini-2.5-flash"), 1_000_000);
});

test("unknown models report null (no catch-all fallback)", () => {
  assert.equal(getModelContextWindow("made-up-model-9000"), null);
  assert.equal(getModelContextWindow("auto"), null);
});

test("empty/undefined model reports null", () => {
  assert.equal(getModelContextWindow(undefined), null);
  assert.equal(getModelContextWindow(""), null);
  assert.equal(getModelContextWindow("   "), null);
});

test("matching is case-insensitive", () => {
  assert.equal(getModelContextWindow("Claude-3-5-Sonnet"), 200_000);
  assert.equal(getModelContextWindow("GPT-4O"), 128_000);
});