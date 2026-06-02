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
    updateTabWorkdir: async () => { called = true; },
  };

  applyWorkdirSelection(tab, "/home/user/project", runtime);

  assert.equal(called, false, "runtime.updateTabWorkdir should not be called");
  assert.ok(tab.toast, "toast should be set");
  assert.equal(tab.toast!.message, "workdir unchanged");
});

test("applyWorkdirSelection skips when paths differ only by trailing slash", () => {
  const tab = makeTab("/home/user/project");
  let called = false;
  const runtime = {
    updateTabWorkdir: async () => { called = true; },
  };

  applyWorkdirSelection(tab, "/home/user/project/", runtime);

  assert.equal(called, false, "runtime.updateTabWorkdir should not be called");
  assert.ok(tab.toast);
});

test("applyWorkdirSelection proceeds when workdir actually changes", () => {
  const tab = makeTab("/home/user/project");
  let called = false;
  const runtime = {
    updateTabWorkdir: async () => { called = true; },
  };

  applyWorkdirSelection(tab, "/home/user/other", runtime);

  assert.equal(called, true, "runtime.updateTabWorkdir should be called");
  assert.equal(tab.toast, undefined, "toast should not be set");
});

test("applyWorkdirSelection updates tab.workdir directly without runtime", () => {
  const tab = makeTab("/home/user/project");

  applyWorkdirSelection(tab, "/home/user/other");

  assert.equal(tab.workdir, "/home/user/other");
  assert.equal(tab.toast, undefined);
});

test("applyWorkdirSelection same-dir without runtime sets toast only", () => {
  const tab = makeTab("/home/user/project");

  applyWorkdirSelection(tab, "/home/user/project");

  assert.equal(tab.workdir, "/home/user/project");
  assert.ok(tab.toast);
  assert.equal(tab.toast!.message, "workdir unchanged");
});
