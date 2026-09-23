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
} from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

/** SGR parameters of the escape sequence that opens the run containing `text`. */
function sgrBefore(line: string, text: string): string | undefined {
  const at = line.indexOf(text);
  assert.ok(at >= 0, `missing text: ${text}`);
  return /\x1b\[([0-9;]*)m(?=[^\x1b]*$)/.exec(line.slice(0, at))?.[1];
}

/** SGR parameters a theme paint function emits. */
function sgrOfPaint(paint: (text: string) => string): string {
  return /\x1b\[([0-9;]*)m/.exec(paint("x"))?.[1] ?? "";
}

test("tab bar shows MixCode Home and the agent label", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  assert.match(
    stripAnsi(renderTabBar({ ...state, activeTabId: "home" }, 80)[0] ?? ""),
    /MixCode Home/,
  );
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

test("working indicator identifies compaction reason", () => {
  const theme = themeForId(createInitialState("/repo").theme);
  const cases = [
    ["manual", "Compacting context...", theme.accent],
    ["threshold", "Auto-compacting...", theme.warning],
    ["overflow", "Context overflow detected, Auto-compacting...", theme.error],
  ] as const;

  for (const [reason, expected, paint] of cases) {
    const tab = createTab(1, "s1", "/repo", {
      status: "running",
      workingStartedAt: "2026-05-10T00:00:00.000Z",
      activeCompactionReason: reason,
    });
    const line = renderWorkingIndicator(tab, 100, new Date("2026-05-10T00:00:03.000Z"), theme).join(
      "\n",
    );
    assert.ok(
      stripAnsi(line).includes(expected),
      `${reason} should render ${expected}, got ${stripAnsi(line)}`,
    );
    assert.equal(sgrBefore(line, expected), sgrOfPaint(paint), `${reason} color`);
  }
});

test("non-compaction working activity keeps the dim treatment", () => {
  const theme = themeForId(createInitialState("/repo").theme);
  const tab = createTab(1, "s1", "/repo", {
    status: "running",
    workingStartedAt: "2026-05-10T00:00:00.000Z",
  });
  const line = renderWorkingIndicator(tab, 100, new Date("2026-05-10T00:00:03.000Z"), theme).join(
    "\n",
  );
  assert.equal(sgrBefore(line, "Working"), sgrOfPaint(theme.dim));
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
  assert.match(text, /## == read ==/);
  assert.match(text, /~~~\nRead a file\n~~~/);
  assert.match(text, /source: pi-builtin \| project \| top-level \| <pi-builtin:read>/);
  // Per-tool token breakdown: the only row plus Total must both be 100%.
  assert.match(text, /^read\s+\d+ chars\s+~\d+ tok\s+100\.0%$/m);
  assert.match(text, /^Total\s+\d+ chars\s+~\d+ tok\s+100\.0%$/m);
  assert.match(renderSystemToolsText([]), /No tools available/);
});

test("input meta shows context usage against the limit", () => {
  const tab = createTab(1, "s1", "/repo", {
    currentContextTokens: 10,
    contextLimit: 200_000,
  });
  const plain = stripAnsi(renderInputMeta(tab, 100, 0, undefined, true, "nerd").join("\n"));
  // Absolute xxk/xxk is on the editor top border; meta shows bar + percent only.
  assert.match(plain, /\uf0c9 \[[█░]+\] 0\.0%/);
  assert.doesNotMatch(plain, /0\.01k\/200k/);
});

test("themeForId rejects unknown theme ids", () => {
  assert.throws(() => themeForId("missing-theme"), /Unknown theme: missing-theme/);
});
