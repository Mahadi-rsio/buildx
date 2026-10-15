import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunSchema, loadEnv } from "./index";

test("createRunSchema accepts a minimal task", () => {
  const parsed = createRunSchema.parse({ task: "add dark mode" });
  assert.equal(parsed.task, "add dark mode");
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.maxSteps, undefined);
});

test("createRunSchema rejects an empty task", () => {
  assert.throws(() => createRunSchema.parse({ task: "" }));
});

test("loadEnv applies defaults and ignores blank values", () => {
  const env = loadEnv({
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "",
    AGENT_MODEL: "",
    AGENT_MAX_STEPS: "",
  });
  assert.deepEqual(env, {
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: undefined,
    AGENT_MODEL: "gpt-4o-mini",
    AGENT_MAX_STEPS: 40,
  });
});

test("loadEnv coerces AGENT_MAX_STEPS to a number", () => {
  const env = loadEnv({ OPENAI_API_KEY: "sk-test", AGENT_MAX_STEPS: "12" });
  assert.equal(env.AGENT_MAX_STEPS, 12);
});

test("loadEnv requires OPENAI_API_KEY", () => {
  assert.throws(() => loadEnv({}));
});
