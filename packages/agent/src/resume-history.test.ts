import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeResumeHistory } from "./resume-history";

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

test("checkpoint history wins when supplied history is an older prefix", () => {
  const checkpoint = [
    turn("user", "first task"),
    turn("assistant", "first result"),
    turn("user", "interrupted task"),
    turn("assistant", "partial progress"),
  ];
  const supplied = checkpoint.slice(0, 2);
  assert.deepEqual(mergeResumeHistory(checkpoint, supplied), checkpoint);
});

test("newer supplied full history wins when it extends the checkpoint", () => {
  const checkpoint = [turn("user", "first"), turn("assistant", "done")];
  const supplied = [...checkpoint, turn("user", "follow-up")];
  assert.deepEqual(mergeResumeHistory(checkpoint, supplied), supplied);
});

test("merges overlapping checkpoint and supplied histories without duplicates", () => {
  const checkpoint = [
    turn("user", "first"),
    turn("assistant", "done"),
    turn("user", "interrupted"),
  ];
  const supplied = [
    turn("user", "interrupted"),
    turn("assistant", "new response"),
    turn("user", "follow-up"),
  ];
  assert.deepEqual(mergeResumeHistory(checkpoint, supplied), [
    ...checkpoint,
    ...supplied.slice(1),
  ]);
});

test("preserves both histories when no exact overlap can be inferred", () => {
  const checkpoint = [turn("user", "interrupted"), turn("assistant", "progress")];
  const supplied = [turn("user", "new task")];
  assert.deepEqual(mergeResumeHistory(checkpoint, supplied), [
    ...checkpoint,
    ...supplied,
  ]);
});

test("returns whichever history is available", () => {
  const history = [turn("user", "task")];
  assert.deepEqual(mergeResumeHistory(history, undefined), history);
  assert.deepEqual(mergeResumeHistory(undefined, history), history);
  assert.deepEqual(mergeResumeHistory(undefined, undefined), []);
});
