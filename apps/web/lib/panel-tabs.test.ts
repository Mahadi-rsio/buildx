import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PANEL_TAB,
  PANEL_TABS,
  isPanelTab,
  toPanelTab,
} from "./panel-tabs";

test("workspace panel exposes files, changes, terminal, and git", () => {
  assert.deepEqual(PANEL_TABS, ["files", "changes", "terminal", "git"]);
  assert.equal(DEFAULT_PANEL_TAB, "files");
});

test("panel tab coercion rejects unknown values", () => {
  assert.equal(isPanelTab("terminal"), true);
  assert.equal(isPanelTab("git"), true);
  assert.equal(isPanelTab("settings"), false);
  assert.equal(isPanelTab(null), false);
  assert.equal(toPanelTab("git"), "git");
  assert.equal(toPanelTab("nope"), "files");
});
