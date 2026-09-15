import assert from "node:assert/strict";
import { test } from "node:test";
import { createStuckGuardConfigOverlay } from "./config-overlay.js";
import { DEFAULT_STUCK_GUARD_CONFIG, type StuckGuardConfig } from "./config.js";

function makeOverlay(options?: { initial?: StuckGuardConfig; answers?: (string | undefined)[] }) {
  const persisted: StuckGuardConfig[] = [];
  const errors: string[] = [];
  const inputs: { id: string; prefill: string }[] = [];
  const answers = [...(options?.answers ?? [])];
  const overlay = createStuckGuardConfigOverlay({
    tui: { requestRender() {} } as never,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    initial: options?.initial ?? DEFAULT_STUCK_GUARD_CONFIG,
    configPath: "/tmp/mpi-stuck-guard.json",
    input: async (row, prefill) => {
      inputs.push({ id: row.id, prefill });
      return answers.shift();
    },
    persist: (next) => {
      persisted.push(next);
      return { ok: true as const };
    },
    onError: (message) => errors.push(message),
    done: () => {},
  });
  return { overlay, persisted, errors, inputs };
}

/** Press keys, then flush the async edit started by Enter. */
async function press(overlay: ReturnType<typeof makeOverlay>["overlay"], keys: string) {
  for (const key of keys) overlay.handleInput(key);
  await new Promise((resolve) => setImmediate(resolve));
}

// Row order in the rendered page; doomLoop.action is index 6, doomLoop.message 7.
function downs(index: number): string {
  return "j".repeat(index);
}

test("doom loop action cycles allow, ask, deny and back, preserving the message", async () => {
  const state = makeOverlay({
    initial: { ...DEFAULT_STUCK_GUARD_CONFIG, doomLoop: { action: "allow", message: "hint" } },
  });
  await press(state.overlay, downs(6) + "\r");
  await press(state.overlay, "\r");
  await press(state.overlay, "\r");
  assert.deepEqual(
    state.persisted.map((config) => config.doomLoop),
    [
      { action: "ask", message: "hint" },
      { action: "deny", message: "hint" },
      { action: "allow", message: "hint" },
    ],
  );
  assert.deepEqual(state.inputs, []);
});

test("doom loop message edits raw text and an empty answer removes it", async () => {
  const state = makeOverlay({
    initial: { ...DEFAULT_STUCK_GUARD_CONFIG, doomLoop: { action: "allow" } },
    answers: ["Change input.", ""],
  });
  await press(state.overlay, downs(7) + "\r");
  assert.deepEqual(state.inputs, [{ id: "doomLoop.message", prefill: "" }]);
  assert.equal(state.persisted[0]!.doomLoop.message, "Change input.");
  await press(state.overlay, "\r");
  assert.deepEqual(state.inputs[1], { id: "doomLoop.message", prefill: "Change input." });
  assert.equal("message" in state.persisted[1]!.doomLoop, false);
  const page = state.overlay.render(100).join("\n");
  assert.match(page, /Doom loop action: "allow"/);
  assert.match(page, /Doom loop message: \(unset\)/);
});

test("canceling the message dialog leaves the config unchanged", async () => {
  const state = makeOverlay({ answers: [undefined] });
  await press(state.overlay, downs(7) + "\r");
  assert.deepEqual(state.inputs, [{ id: "doomLoop.message", prefill: "" }]);
  assert.deepEqual(state.persisted, []);
});

test("number rows keep the JSON input path and report invalid JSON", async () => {
  const state = makeOverlay({ answers: ["450", "abc"] });
  await press(state.overlay, downs(2) + "\r");
  assert.equal(state.persisted[0]!.streamStartTimeoutSeconds, 450);
  await press(state.overlay, "\r");
  assert.match(state.errors[0]!, /^Error: invalid JSON value: /);
  assert.equal(state.persisted.length, 1);
});

test("the watchdog toggle persists immediately without an input dialog", async () => {
  const state = makeOverlay();
  await press(state.overlay, "\r");
  assert.equal(state.persisted[0]!.streamWatchdogEnabled, false);
  assert.deepEqual(state.inputs, []);
});
