import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TERMINAL_HISTORY_LIMIT,
  pushTerminalHistory,
  takeNdjsonRecords,
  terminalCellSize,
  terminalHistoryKey,
} from "./terminal-client";

test("ndjson parser keeps a partial trailing frame", () => {
  const first = takeNdjsonRecords(
    '{"type":"start","command":"ls","tty":true}\n{"type":"stdout","data":"a"}\n{"type":"exit"',
  );
  assert.equal(first.records.length, 2);
  assert.deepEqual(first.records[0], {
    type: "start",
    command: "ls",
    tty: true,
  });
  assert.equal(first.rest, '{"type":"exit"');

  const second = takeNdjsonRecords(`${first.rest},"exitCode":0}\n`);
  assert.deepEqual(second.records, [{ type: "exit", exitCode: 0 }]);
  assert.equal(second.rest, "");
});

test("ndjson parser ignores malformed and non-record lines", () => {
  const parsed = takeNdjsonRecords(
    '\nnot-json\n{"type":"stderr","data":"warn"}\n{}\n',
  );
  assert.deepEqual(parsed.records, [{ type: "stderr", data: "warn" }]);
});

test("history is scoped by workspace and capped", () => {
  assert.equal(terminalHistoryKey("ws-1"), "buildx.terminal.history.ws-1");
  const current = Array.from({ length: TERMINAL_HISTORY_LIMIT }, (_, i) => `cmd-${i}`);
  const next = pushTerminalHistory("ws-1", "new-command", current);
  assert.equal(next.length, TERMINAL_HISTORY_LIMIT);
  assert.equal(next[0], "new-command");
  assert.equal(next.includes("cmd-49"), false);

  const deduped = pushTerminalHistory("ws-1", "cmd-1", ["cmd-1", "cmd-2"]);
  assert.deepEqual(deduped, ["cmd-1", "cmd-2"]);
});

test("cell size clamps tiny and huge panes", () => {
  assert.deepEqual(terminalCellSize(0, 0), { cols: 20, rows: 5 });
  assert.deepEqual(terminalCellSize(720, 360), { cols: 100, rows: 20 });
  assert.deepEqual(terminalCellSize(100_000, 100_000), { cols: 500, rows: 200 });
});
