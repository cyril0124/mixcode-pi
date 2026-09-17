import assert from "node:assert/strict";
import { test } from "node:test";
import { createMixCodeExtensionUiContext } from "../src/agent/runtime-extension-ui.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";

// Extension notifications land in the chat transcript. MixCode adds the
// Warning:/Error: markers itself, while Pi renders notify text verbatim, so
// extensions may legitimately embed a marker of their own.

function makeTab(): RuntimeTab {
  return {
    chat: [],
    extensionTerminalInputHandlers: new Set(),
  } as unknown as RuntimeTab;
}

test("error notices render exactly one Error: marker", () => {
  const tab = makeTab();
  const ui = createMixCodeExtensionUiContext(
    tab,
    () => undefined,
    () => undefined,
  );

  ui.notify("Error: Usage: /permission [list | probe]", "error");
  ui.notify("config file is unreadable", "error");
  ui.notify("Error: permission config invalid (/tmp/x.json): bad JSON", "error");

  assert.deepEqual(
    tab.chat.map((line) => line.text),
    [
      "Error: Usage: /permission [list | probe]",
      "Error: config file is unreadable",
      "Error: permission config invalid (/tmp/x.json): bad JSON",
    ],
  );
});

test("warning and info notices keep their own marker rules", () => {
  const tab = makeTab();
  const ui = createMixCodeExtensionUiContext(
    tab,
    () => undefined,
    () => undefined,
  );

  ui.notify("stall check failed", "warning");
  ui.notify("permission rules (none)", "info");

  assert.deepEqual(
    tab.chat.map((line) => line.text),
    ["Warning: stall check failed", "permission rules (none)"],
  );
});
