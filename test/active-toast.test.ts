import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab, pushToast, activeToast } from "../src/index.js";

test("pushToast stores type+message and sets createdAt as number", () => {
  const tab = createTab(1, "s1", "/repo");
  const before = Date.now();

  pushToast(tab, { type: "info", message: "hello" });

  const after = Date.now();
  assert.equal(tab.toast?.type, "info");
  assert.equal(tab.toast?.message, "hello");
  assert.equal(typeof tab.toast?.createdAt, "number");
  assert.ok(tab.toast!.createdAt >= before);
  assert.ok(tab.toast!.createdAt <= after);
});

test("activeToast returns undefined and clears tab.toast when older than 3000ms", () => {
  const tab = createTab(1, "s1", "/repo");
  pushToast(tab, { type: "warning", message: "stale" });
  tab.toast!.createdAt = Date.now() - 3001;

  const toast = activeToast(tab);

  assert.equal(toast, undefined);
  assert.equal(tab.toast, undefined);
});

test("activeToast returns toast when age is still within window", () => {
  const tab = createTab(1, "s1", "/repo");
  pushToast(tab, { type: "error", message: "fresh" });
  tab.toast!.createdAt = Date.now() - 1000;

  const toast = activeToast(tab);

  assert.equal(toast?.type, "error");
  assert.equal(toast?.message, "fresh");
  assert.equal(tab.toast, toast);
});
