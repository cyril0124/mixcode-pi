import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { bindTerminalProgress } from "../src/ui/app-runtime.js";

// Contract: terminal.showTerminalProgress drives terminal.setProgress(true)
// while any tab is working, back to false when all tabs settle, forced off on
// stop, and never called while the setting is disabled.

function setup(enabled: boolean) {
  const state = createInitialState("/tmp/terminal-progress-test");
  state.tabs.push(createTab(1, "session-1", state.workdir));
  const calls: boolean[] = [];
  const stop = bindTerminalProgress(state, { setProgress: (v) => calls.push(v) }, () => enabled);
  return { state, calls, stop };
}

async function nextTick(): Promise<void> {
  // One 80ms poll interval plus slack; keeps the test real-timer based.
  await new Promise((resolve) => setTimeout(resolve, 160));
}

test("bindTerminalProgress flips setProgress on working transitions and stop", async () => {
  const { state, calls, stop } = setup(true);
  try {
    await nextTick();
    assert.deepEqual(calls, [], "idle tabs must not emit progress");

    state.tabs[0]!.status = "running";
    await nextTick();
    assert.deepEqual(calls, [true], "working tab turns progress on exactly once");

    await nextTick();
    assert.deepEqual(calls, [true], "steady working state emits no extra writes");

    state.tabs[0]!.status = "idle";
    await nextTick();
    assert.deepEqual(calls, [true, false], "settled tabs turn progress off");
  } finally {
    stop();
  }
  assert.deepEqual(calls, [true, false], "stop while off adds no write");

  const again = setup(true);
  again.state.tabs[0]!.status = "thinking";
  await nextTick();
  again.stop();
  assert.deepEqual(again.calls, [true, false], "stop while on forces progress off");
});

test("bindTerminalProgress never writes when the setting is disabled", async () => {
  const { state, calls, stop } = setup(false);
  try {
    state.tabs[0]!.status = "running";
    await nextTick();
    assert.deepEqual(calls, []);
  } finally {
    stop();
  }
  assert.deepEqual(calls, [], "stop without prior progress stays silent");
});
