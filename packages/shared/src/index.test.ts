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

test("createRunSchema accepts supported context windows only", () => {
  assert.equal(
    createRunSchema.parse({ task: "x", contextWindow: 200_000 }).contextWindow,
    200_000,
  );
  assert.throws(() =>
    createRunSchema.parse({ task: "x", contextWindow: 300_000 }),
  );
});

test("loadEnv applies defaults and ignores blank values", () => {
  const env = loadEnv({
    AGENT_MODEL: "",
    AGENT_MAX_STEPS: "",
  });
  assert.deepEqual(env, {
    AGENT_MODEL: "auto",
    AGENT_MAX_STEPS: 40,
  });
});

test("loadEnv coerces AGENT_MAX_STEPS to a number", () => {
  const env = loadEnv({ AGENT_MAX_STEPS: "12" });
  assert.equal(env.AGENT_MAX_STEPS, 12);
});
