import assert from "node:assert/strict";
import { test } from "node:test";
import { appendSystemMessage } from "../src/agent/runtime-chat.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { createTab } from "../src/core/defaults.js";

/** Minimal RuntimeTab for status coalesce behavior. */
function fakeRuntimeTab(): RuntimeTab {
  const tab = createTab(1, "s1", "/tmp");
  return {
    tab,
    chat: [],
  } as unknown as RuntimeTab;
}

test("consecutive status messages replace the last status line (Pi showStatus)", () => {
  const runtimeTab = fakeRuntimeTab();
  appendSystemMessage(runtimeTab, "Thinking level: off");
  appendSystemMessage(runtimeTab, "Thinking level: high");
  appendSystemMessage(runtimeTab, "Model: claude");

  assert.equal(runtimeTab.chat.length, 1);
  assert.equal(runtimeTab.chat[0]?.role, "system");
  assert.equal(runtimeTab.chat[0]?.text, "Model: claude");
  assert.equal(runtimeTab.chat[0]?.systemStatus, true);
  assert.equal(runtimeTab.tab.previewMessages.length, 1);
  assert.equal(runtimeTab.tab.previewMessages[0]?.text, "Model: claude");
});

test("error and warning system messages always append and break status coalesce", () => {
  const runtimeTab = fakeRuntimeTab();
  appendSystemMessage(runtimeTab, "Ready");
  appendSystemMessage(runtimeTab, "Error: boom");
  appendSystemMessage(runtimeTab, "Extension warning: careful", "warning");
  appendSystemMessage(runtimeTab, "After warning");

  assert.deepEqual(
    runtimeTab.chat.map((line) => line.text),
    ["Ready", "Error: boom", "Extension warning: careful", "After warning"],
  );
  assert.equal(runtimeTab.chat[0]?.systemStatus, true);
  assert.equal(runtimeTab.chat[1]?.variant, "system-error");
  assert.equal(runtimeTab.chat[1]?.systemStatus, undefined);
  assert.equal(runtimeTab.chat[2]?.systemStatus, undefined);
  assert.equal(runtimeTab.chat[3]?.systemStatus, true);
});

test("non-status chat lines break status coalesce", () => {
  const runtimeTab = fakeRuntimeTab();
  appendSystemMessage(runtimeTab, "status-a");
  runtimeTab.chat.push({ role: "user", text: "hello" });
  appendSystemMessage(runtimeTab, "status-b");

  assert.deepEqual(
    runtimeTab.chat.map((line) => line.text),
    ["status-a", "hello", "status-b"],
  );
});

test("block system messages stay permanent and are not replaced by status", () => {
  const runtimeTab = fakeRuntimeTab();
  appendSystemMessage(runtimeTab, "Session Info\nFile: /tmp/s.jsonl", "block");
  appendSystemMessage(runtimeTab, "Thinking level: high", "status");

  assert.deepEqual(
    runtimeTab.chat.map((line) => ({ text: line.text, systemStatus: line.systemStatus })),
    [
      { text: "Session Info\nFile: /tmp/s.jsonl", systemStatus: undefined },
      { text: "Thinking level: high", systemStatus: true },
    ],
  );
});
