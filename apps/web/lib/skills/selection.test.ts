import assert from "node:assert/strict";
import { test } from "node:test";
import {
  duplicateCandidateNames,
  filterSkillCandidates,
  selectedCandidates,
  selectAllValid,
  toggleSelected,
  uniquePaths,
} from "./selection";

const candidates = [
  { path: "skills/engineering/code-review", name: "code-review", description: "Review code changes." },
  { path: "skills/writing/docs", name: "docs", description: "Write documentation." },
  { path: "skills/broken", name: "broken", valid: false },
];

test("single-skill sources auto-select the only valid candidate", () => {
  const selected = selectAllValid([candidates[0]]);
  assert.deepEqual([...selected], ["skills/engineering/code-review"]);
  assert.deepEqual(selectedCandidates([candidates[0]], selected), [candidates[0]]);
});

test("multi-skill sources select all valid candidates and support toggling", () => {
  const selected = selectAllValid(candidates);
  assert.deepEqual([...selected], ["skills/engineering/code-review", "skills/writing/docs"]);
  const toggled = toggleSelected(selected, "skills/writing/docs");
  assert.equal(toggled.has("skills/writing/docs"), false);
  assert.equal(selected.size, 2);
  assert.deepEqual(
    selectedCandidates(candidates, toggled).map((candidate) => candidate.name),
    ["code-review"],
  );
});

test("filters by name, path and description", () => {
  assert.deepEqual(
    filterSkillCandidates(candidates, "review").map((candidate) => candidate.name),
    ["code-review"],
  );
  assert.deepEqual(
    filterSkillCandidates(candidates, "engineering").map((candidate) => candidate.name),
    ["code-review"],
  );
  assert.deepEqual(
    filterSkillCandidates(candidates, "DOCUMENTATION").map((candidate) => candidate.name),
    ["docs"],
  );
  assert.deepEqual(filterSkillCandidates(candidates, ""), candidates);
});

test("ignores invalid candidates and deduplicates selected paths", () => {
  const selected = selectAllValid(candidates);
  assert.equal(selected.has("skills/broken"), false);
  assert.deepEqual(
    uniquePaths(["a", "a", " b ", "", "b"]),
    ["a", "b", ""],
  );
});

test("detects duplicate installs by skill name", () => {
  const duplicates = duplicateCandidateNames(candidates, [
    { name: "code-review" },
    { name: "unrelated" },
  ]);
  assert.deepEqual([...duplicates], ["code-review"]);
  assert.equal(duplicateCandidateNames(candidates, []).size, 0);
});
