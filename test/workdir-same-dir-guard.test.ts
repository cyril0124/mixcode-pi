import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWorkdirSelection } from "../src/ui/app-actions.js";
import type { MixCodeState } from "../src/core/types.js";

function makeTab(workdir: string): MixCodeState["tabs"][number] {
  return {
    sessionId: "s1",
    workdir,
    toast: undefined,
  } as unknown as MixCodeState["tabs"][number];
}

test("applyWorkdirSelection skips and toasts when workdir is unchanged", () => {
  const tab = makeTab("/home/user/project");
  let called = false;
  const runtime = {
    updateTabWorkdir: async () => {
      called = true;
    },
  };

  applyWorkdirSelection(tab, "/home/user/project", runtime);
  assert.equal(called, false);
  assert.equal(tab.toast?.message, "workdir unchanged");

  applyWorkdirSelection(tab, "/home/user/project/", runtime);
  assert.equal(called, false);
  assert.equal(tab.toast?.message, "workdir unchanged");
});

test("applyWorkdirSelection proceeds when workdir actually changes", () => {
  const tab = makeTab("/home/user/project");
  let called = false;
  const runtime = {
    updateTabWorkdir: async () => {
      called = true;
    },
  };

  applyWorkdirSelection(tab, "/home/user/other", runtime);

  assert.equal(called, true);
  assert.equal(tab.toast, undefined);
});

test("applyWorkdirSelection without runtime updates workdir or toasts same-dir", () => {
  const tab = makeTab("/home/user/project");

  applyWorkdirSelection(tab, "/home/user/other");
  assert.equal(tab.workdir, "/home/user/other");
  assert.equal(tab.toast, undefined);

  applyWorkdirSelection(tab, "/home/user/other");
  assert.equal(tab.workdir, "/home/user/other");
  assert.equal(tab.toast?.message, "workdir unchanged");
});
