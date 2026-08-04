import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createInitialState,
  createTab,
  renderInputMeta,
  renderSystemToolsText,
  renderTabBar,
  renderWorkingIndicator,
  themeForId,
} from "../src/index.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("tab bar shows MixCode Home and the agent label", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  assert.match(stripAnsi(renderTabBar({ ...state, activeTabId: "config" }, 80)[0] ?? ""), /MixCode Home/);
  assert.match(stripAnsi(renderTabBar(state, 80)[0] ?? ""), /Agent-01/);
});

test("working indicator shows elapsed duration and interrupt hint while busy", () => {
  const lines = renderWorkingIndicator(
    createTab(1, "s1", "/repo", {
      status: "thinking",
      workingStartedAt: "2026-05-10T00:00:00.000Z",
    }),
    80,
    new Date("2026-05-10T00:02:22.000Z"),
  );
  assert.match(stripAnsi(lines.join("\n")), /Working \(2m 22s . esc to interrupt\)/);
});

test("working indicator shows completed duration after work ends", () => {
  const lines = renderWorkingIndicator(
    createTab(1, "s1", "/repo", { lastWorkedDurationSeconds: 291 }),
    80,
  );
  assert.match(stripAnsi(lines.join("\n")), /Worked for 4m 51s/);
});

test("system tools text includes name, description, and source metadata", () => {
  const text = renderSystemToolsText([
    {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
      sourceInfo: {
        source: "builtin",
        scope: "project",
        origin: "top-level",
        path: "<builtin:read>",
      },
    },
  ]);
  assert.match(text, /## read/);
  assert.match(text, /Read a file/);
  assert.match(text, /source: pi-builtin \| project \| top-level \| <pi-builtin:read>/);
  assert.match(renderSystemToolsText([]), /No tools available/);
});

test("input meta shows context usage against the limit", () => {
  const tab = createTab(1, "s1", "/repo", {
    currentContextTokens: 10,
    contextLimit: 200_000,
  });
  const plain = stripAnsi(renderInputMeta(tab, 100).join("\n"));
  // Absolute xxk/xxk is on the editor top border; meta shows bar + percent only.
  assert.match(plain, /░|█/);
  assert.match(plain, /0%/);
  assert.doesNotMatch(plain, /0\.01k\/200k/);
});

test("themeForId rejects unknown theme ids", () => {
  assert.throws(() => themeForId("missing-theme"), /Unknown theme: missing-theme/);
});
