import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_COMMANDS } from "../src/core/commands.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { OverlayTui } from "../src/ui/app-types.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// ─── command registration ────────────────────────────────────────────────────

test("hide-thinking is a registered local command", () => {
  const command = LOCAL_COMMANDS.find((cmd) => cmd.name === "hide-thinking");
  assert.ok(command, "command registered");
  assert.match(command.description, /thinking/i);
  assert.ok(command.palette, "command has palette metadata");
});

// ─── /hide-thinking command behavior ─────────────────────────────────────────

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
  state.activeTabId = "config";
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

// ─── rendering: thinking collapses to placeholder when hidden ────────────────

test("renderAgentSurface hides thinking content behind a placeholder", () => {
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
    }).join("\n"),
  );
  // Thinking content is gone; a placeholder replaces it; assistant text stays.
  assert.doesNotMatch(hidden, /secret reasoning trace/);
  assert.match(hidden, /Thinking\.\.\./);
  assert.match(hidden, /final answer/);
});
