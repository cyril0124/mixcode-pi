import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { OverlayTui } from "../src/ui/app-types.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("/hide-thinking toggles state, persists via runtime, and toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  assert.equal(state.hideThinkingBlock ?? false, false);

  const persisted: boolean[] = [];
  const runtime = {
    getTab: () => undefined,
    setHideThinkingBlock: (hide: boolean) => persisted.push(hide),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  // Toggle on.
  await handleSubmittedInput(state, runtime, "/hide-thinking", tui);
  assert.equal(state.hideThinkingBlock, true);
  assert.deepEqual(persisted, [true]);
  assert.match(state.tabs[0]?.toast?.message ?? "", /hidden/i);

  // Toggle off.
  await handleSubmittedInput(state, runtime, "/hide-thinking", tui);
  assert.equal(state.hideThinkingBlock, false);
  assert.deepEqual(persisted, [true, false]);
  assert.match(state.tabs[0]?.toast?.message ?? "", /visible/i);
});

test("/hide-thinking from Home pushes toast on the selected agent", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const runtime = {
    getTab: () => undefined,
    setHideThinkingBlock: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(
    state,
    runtime,
    "/hide-thinking",
    tui,
    undefined,
    undefined,
    undefined,
    state.tabs[0],
  );

  assert.equal(state.hideThinkingBlock, true);
  assert.match(state.tabs[0]?.toast?.message ?? "", /Thinking blocks: hidden/i);
});

test("/hide-thinking keeps state unchanged when persistence fails", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const messages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, message: string) => messages.push(message),
    getTab: () => undefined,
    setHideThinkingBlock: () => {
      throw new Error("settings disk is read-only");
    },
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(state, runtime, "/hide-thinking", tui);

  assert.equal(state.hideThinkingBlock ?? false, false);
  assert.equal(state.tabs[0]?.toast, undefined);
  assert.deepEqual(messages, ["Hide thinking failed: settings disk is read-only"]);
});

test("renderAgentSurface keeps short hidden thinking in the tail window", () => {
  const chat = [
    { role: "thinking", text: "secret reasoning trace" },
    { role: "assistant", text: "final answer" },
  ];

  const visible = stripAnsi(
    renderAgentSurface(createTab(1, "s1", "/repo"), { chat } as never, 100).join("\n"),
  );
  assert.match(visible, /secret reasoning trace/);
  assert.match(visible, /final answer/);

  const hidden = stripAnsi(
    renderAgentSurface(createTab(2, "s2", "/repo"), { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  // Short thinking stays visible in the 3-row window; assistant text stays.
  assert.match(hidden, /secret reasoning trace/);
  assert.doesNotMatch(hidden, /Thinking\.\.\./);
  assert.match(hidden, /final answer/);
});

test("hidden thinking defaults to the Thinking... placeholder without the boxed setting", () => {
  const chat = [
    { role: "thinking", text: thinkingLines("line").join("\n") },
    { role: "assistant", text: "final answer" },
  ];

  const hidden = stripAnsi(
    renderAgentSurface(createTab(1, "s1", "/repo"), { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: false,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking\.\.\./);
  assert.doesNotMatch(hidden, /line-19/);
  assert.doesNotMatch(hidden, /╭/);
  assert.match(hidden, /final answer/);
});

test("hidden thinking placeholder uses extensionUi.hiddenThinkingLabel when set", () => {
  const chat = [{ role: "thinking", text: thinkingLines("line").join("\n") }];
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.hiddenThinkingLabel = "Reasoning folded";

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.doesNotMatch(hidden, /line-19/);
  assert.match(hidden, /Reasoning folded/);

  tab.extensionUi.hiddenThinkingLabel = undefined;
  const restored = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(restored, /line-19/);
  assert.doesNotMatch(restored, /Reasoning folded/);

  // Label also wins in default placeholder mode.
  tab.extensionUi.hiddenThinkingLabel = "Reasoning folded";
  const plain = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: false,
    }).join("\n"),
  );
  assert.match(plain, /Reasoning folded/);
  assert.doesNotMatch(plain, /line-19/);
  assert.doesNotMatch(plain, /Thinking\.\.\./);
});

function thinkingLines(text: string): string[] {
  return Array.from({ length: 20 }, (_, index) => `${text}-${String(index).padStart(2, "0")}`);
}

test("hidden thinking viewport shows a 3-row tail of that block", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: thinkingLines("line").join("\n") }];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  const content = hidden
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(content.length, 5);
  assert.match(content[0]!, /Thinking/);
  assert.match(content[1]!, /… line-17/);
  assert.match(content[2]!, /line-18/);
  assert.match(content[3]!, /line-19/);
  assert.match(content[4]!, /╰/);
  assert.doesNotMatch(hidden, /line-00/);
  assert.doesNotMatch(hidden, /Thinking\.\.\./);
});

test("hidden thinking viewport follows the tail as text grows", () => {
  const tab = createTab(1, "s1", "/repo");
  const short = [{ role: "thinking", text: thinkingLines("line").slice(0, 11).join("\n") }];
  const first = stripAnsi(
    renderAgentSurface(tab, { chat: short } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(first, /line-10/);
  assert.doesNotMatch(first, /line-19/);

  const long = [{ role: "thinking", text: thinkingLines("line").join("\n") }];
  const second = stripAnsi(
    renderAgentSurface(tab, { chat: long } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(second, /line-19/);
  assert.doesNotMatch(second, /line-10/);
});

test("hidden thinking viewport keeps short text without an ellipsis", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: "one\ntwo" }];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking/);
  assert.match(hidden, /one/);
  assert.match(hidden, /two/);
  assert.match(hidden, /╭/);
  assert.match(hidden, /╰/);
  assert.doesNotMatch(hidden, /…/);
});

test("hidden thinking viewport of a long body is 3 rows and drops the head", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [
    {
      role: "thinking",
      text: `HEAD-UNIQUE\n${"x".repeat(100_000)}\nTAIL-UNIQUE`,
    },
  ];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 40, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  const content = hidden
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(content.length, 5);
  assert.match(hidden, /Thinking/);
  assert.match(hidden, /TAIL-UNIQUE/);
  assert.doesNotMatch(hidden, /HEAD-UNIQUE/);
});

test("visible thinking is not truncated when hideThinking is off", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: thinkingLines("line").join("\n") }];

  const visible = stripAnsi(renderAgentSurface(tab, { chat } as never, 100).join("\n"));
  assert.match(visible, /line-00/);
  assert.match(visible, /line-19/);
});

test("boxed hidden thinking shows a live timer in the title while streaming", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [
    {
      role: "thinking",
      text: thinkingLines("line").join("\n"),
      thinkingStartedAt: Date.now() - 5000,
    },
  ];
  const runtimeTab = {
    chat,
    streamingAssistant: {
      chatIndex: 0,
      blockIndices: new Map([[0, 0]]),
      toolCallIndices: new Map(),
    },
  };

  const hidden = stripAnsi(
    renderAgentSurface(tab, runtimeTab as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking · 5s/);
});

test("boxed hidden thinking freezes the timer once the message ended", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [
    {
      role: "thinking",
      text: thinkingLines("line").join("\n"),
      thinkingStartedAt: 1000,
      thinkingEndedAt: 1000 + 65_000,
    },
  ];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking · 1m 05s/);
});

test("boxed hidden thinking title has no timer for restored history blocks", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: "restored reasoning" }];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking/);
  assert.doesNotMatch(hidden, /Thinking ·/);
});
