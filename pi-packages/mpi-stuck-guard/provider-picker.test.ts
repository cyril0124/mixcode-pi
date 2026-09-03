import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderPicker } from "./provider-picker.js";

function makePicker() {
  let saved: string[] | undefined;
  const picker = createProviderPicker({
    tui: { requestRender() {} } as never,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    providers: ["alpha-jk", "beta", "jupiter"],
    selected: [],
    done: (providers) => {
      saved = providers;
    },
  });
  return {
    picker,
    get saved() {
      return saved;
    },
  };
}

test("provider picker treats j and k as search text", () => {
  const { picker } = makePicker();
  picker.handleInput("j");
  picker.handleInput("k");
  const text = picker.render(100).join("\n");
  assert.match(text, /Search: jk/);
  assert.match(text, /alpha-jk/);
});

test("provider picker uses arrows for navigation and Enter for selection", () => {
  const state = makePicker();
  state.picker.handleInput("\x1b[B");
  state.picker.handleInput("\r");
  state.picker.handleInput("\x1b");
  assert.deepEqual(state.saved, ["beta"]);
});
