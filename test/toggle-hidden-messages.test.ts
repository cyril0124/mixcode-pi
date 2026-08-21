import assert from "node:assert/strict";
import { test } from "node:test";
import { customMessageToChatLine, entriesToChatLines } from "../src/agent/runtime-chat.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { OverlayTui } from "../src/ui/app-types.js";

/** Minimal RuntimeTab stub for chat-line rendering and toggle handling. */
function fakeRuntimeTab(options?: {
  showHiddenMessages?: boolean;
  branch?: unknown[];
}): RuntimeTab {
  return {
    showHiddenMessages: options?.showHiddenMessages,
    chat: [],
    session: { getBranch: () => options?.branch ?? [] },
    agentSession: {
      settingsManager: { getShowCacheMissNotices: () => false },
      extensionRunner: { getMessageRenderer: () => undefined },
    },
  } as unknown as RuntimeTab;
}

function customMessage(display: boolean) {
  return {
    role: "custom" as const,
    customType: "skill-refs",
    content: "The user explicitly invoked skills...",
    display,
    timestamp: Date.now(),
  };
}

// ─── customMessageToChatLine visibility states ───────────────────────────────

test("hidden custom message stays hidden by default", () => {
  const line = customMessageToChatLine(customMessage(false), fakeRuntimeTab());
  assert.equal(line, undefined);
});

test("hidden custom message renders with [hidden] marker when toggled on", () => {
  const line = customMessageToChatLine(
    customMessage(false),
    fakeRuntimeTab({ showHiddenMessages: true }),
  );
  assert.ok(line);
  assert.equal(line.role, "extension");
  assert.equal(line.title, "extension skill-refs [hidden]");
  assert.match(line.text, /explicitly invoked skills/);
});

test("visible custom message keeps its normal title when toggled on", () => {
  const line = customMessageToChatLine(
    customMessage(true),
    fakeRuntimeTab({ showHiddenMessages: true }),
  );
  assert.ok(line);
  assert.equal(line.title, "extension skill-refs");
});

// ─── /toggle-hidden-messages command behavior ────────────────────────────────

test("/toggle-hidden-messages flips the flag, rebuilds chat, and toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";

  const branch = [
    {
      type: "custom_message",
      id: "e1",
      customType: "skill-refs",
      content: "hidden injection",
      display: false,
      timestamp: new Date().toISOString(),
    },
  ];
  const runtimeTab = fakeRuntimeTab({ branch });
  const runtime = {
    getTab: (sessionId: string) => (sessionId === "s1" ? runtimeTab : undefined),
    rebuildChatFromSession: (sessionId: string) => {
      const tab = runtime.getTab(sessionId);
      if (!tab) throw new Error(`Unknown tab session: ${sessionId}`);
      tab.chat = entriesToChatLines(tab.session.getBranch(), tab);
    },
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  // Toggle on: flag set, hidden entry appears in rebuilt chat, toast reports state.
  await handleSubmittedInput(state, runtime, "/toggle-hidden-messages", tui);
  assert.equal(runtimeTab.showHiddenMessages, true);
  assert.equal(runtimeTab.chat.length, 1);
  assert.equal(runtimeTab.chat[0]?.title, "extension skill-refs [hidden]");
  assert.match(state.tabs[0]?.toast?.message ?? "", /shown/i);

  // Toggle off: flag cleared, hidden entry filtered out again.
  await handleSubmittedInput(state, runtime, "/toggle-hidden-messages", tui);
  assert.equal(runtimeTab.showHiddenMessages, false);
  assert.equal(runtimeTab.chat.length, 0);
  assert.match(state.tabs[0]?.toast?.message ?? "", /hidden/i);
});

test("/toggle-hidden-messages warns when runtime tab is missing", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(state, runtime, "/toggle-hidden-messages", tui);
  assert.equal(state.tabs[0]?.toast?.type, "warning");
});

// ─── entriesToChatLines integration (branch rebuild path) ────────────────────

test("entriesToChatLines respects the showHiddenMessages flag", () => {
  const branch = [
    {
      type: "custom_message",
      id: "e1",
      customType: "note",
      content: "hidden note",
      display: false,
      timestamp: new Date().toISOString(),
    },
  ] as never[];
  const hiddenTab = fakeRuntimeTab({ branch });
  assert.equal(entriesToChatLines(branch, hiddenTab).length, 0);
  const shownTab = fakeRuntimeTab({ branch, showHiddenMessages: true });
  const lines = entriesToChatLines(branch, shownTab);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.title, "extension note [hidden]");
});
