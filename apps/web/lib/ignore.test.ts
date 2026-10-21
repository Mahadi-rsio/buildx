import assert from "node:assert/strict";
import { test } from "node:test";
import { createIgnoreMatcher } from "./ignore";

test("matches gitignore files, directories and lockfiles", () => {
  const ignored = createIgnoreMatcher([
    "# generated",
    "node_modules",
    "*.log",
    "coverage/",
    "/dist",
    "**/tmp",
  ]);
  assert.equal(ignored("node_modules/pkg/index.js", false), true);
  assert.equal(ignored("debug.log", false), true);
  assert.equal(ignored("logs/debug.log", false), true);
  assert.equal(ignored("coverage", true), true);
  assert.equal(ignored("coverage/report.html", false), true);
  assert.equal(ignored("dist/bundle.js", false), true);
  assert.equal(ignored("src/tmp/cache.json", false), true);
  assert.equal(ignored("pnpm-lock.yaml", false), true);
  assert.equal(ignored("src/index.ts", false), false);
});

test("last matching rule wins for negations", () => {
  const ignored = createIgnoreMatcher(["*.log", "!keep.log"]);
  assert.equal(ignored("debug.log", false), true);
  assert.equal(ignored("keep.log", false), false);
});
