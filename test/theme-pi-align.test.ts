import assert from "node:assert/strict";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
  listThemeInfos,
  normalizeThemeId,
  registerAdditionalTheme,
  registerMixCodeThemes,
  resolvePiTheme,
  themeForId,
} from "../src/ui/themes.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { renderTabBar } from "../src/ui/rendering/chrome.js";
import { mixCodeThemeFromPi } from "../src/ui/theme-from-pi.js";

function sampleTheme(
  name: string,
  overrides: Partial<ConstructorParameters<typeof Theme>[0]> = {},
): Theme {
  return new Theme(
    {
      accent: "#112233",
      border: "#223344",
      borderAccent: "#334455",
      borderMuted: "#445566",
      success: "#00ff00",
      error: "#ff0000",
      warning: "#ffff00",
      muted: "#888888",
      dim: "#666666",
      text: "#eeeeee",
      thinkingText: "#aaaaaa",
      userMessageText: "#eeeeee",
      customMessageText: "#eeeeee",
      customMessageLabel: "#bbbbbb",
      toolTitle: "#cccccc",
      toolOutput: "#999999",
      mdHeading: "#dddd00",
      mdLink: "#0000ff",
      mdLinkUrl: "#555555",
      mdCode: "#00dddd",
      mdCodeBlock: "#00aa00",
      mdCodeBlockBorder: "#444444",
      mdQuote: "#777777",
      mdQuoteBorder: "#555555",
      mdHr: "#555555",
      mdListBullet: "#00dddd",
      toolDiffAdded: "#00ff00",
      toolDiffRemoved: "#ff0000",
      toolDiffContext: "#888888",
      syntaxComment: "#6A9955",
      syntaxKeyword: "#569CD6",
      syntaxFunction: "#DCDCAA",
      syntaxVariable: "#9CDCFE",
      syntaxString: "#CE9178",
      syntaxNumber: "#B5CEA8",
      syntaxType: "#4EC9B0",
      syntaxOperator: "#D4D4D4",
      syntaxPunctuation: "#D4D4D4",
      thinkingOff: "#505050",
      thinkingMinimal: "#606060",
      thinkingLow: "#707070",
      thinkingMedium: "#808080",
      thinkingHigh: "#909090",
      thinkingXhigh: "#a0a0a0",
      thinkingMax: "#b0b0b0",
      bashMode: "#00ff88",
      ...overrides,
    },
    {
      selectedBg: "#1a2a3a",
      userMessageBg: "#2a3a4a",
      customMessageBg: "#3a2a4a",
      toolPendingBg: "#222222",
      toolSuccessBg: "#113311",
      toolErrorBg: "#331111",
    },
    "truecolor",
    { name },
  );
}

test("registerAdditionalTheme makes third-party theme listable and adaptable", () => {
  registerMixCodeThemes();
  const custom = sampleTheme("plugin-sample");
  registerAdditionalTheme(custom);

  assert.equal(normalizeThemeId("plugin-sample"), "plugin-sample");
  assert.ok(listThemeInfos().some((theme) => theme.id === "plugin-sample"));
  assert.equal(resolvePiTheme("plugin-sample"), custom);

  const mix = themeForId("plugin-sample");
  assert.equal(mix.name, "plugin-sample");
  // Pi-named fields are present and color text (not identity).
  assert.match(mix.error("x"), /x/);
  assert.match(mix.muted("x"), /x/);
  assert.match(mix.borderMuted("x"), /x/);
  assert.match(mix.bashMode("x"), /x/);
  assert.match(mix.selectedBg("x"), /x/);
  assert.notEqual(mix.error("x"), "x");
});

test("mixCodeThemeFromPi maps Pi tokens onto Pi-named MixCode fields", () => {
  const adapted = mixCodeThemeFromPi(sampleTheme("adapter-check"));
  assert.equal(adapted.name, "adapter-check");
  assert.equal(typeof adapted.error, "function");
  assert.equal(typeof adapted.muted, "function");
  assert.equal(typeof adapted.toolTitle, "function");
  assert.equal(typeof adapted.thinkingText, "function");
  assert.equal(typeof adapted.userMessageBg, "function");
  assert.ok(adapted.toolPendingBg.start !== undefined);
  assert.ok(adapted.customMessageBg.start !== undefined);
});

test("default status colors survive tab styling and restore the title foreground", () => {
  const theme = mixCodeThemeFromPi(
    sampleTheme("default-status", {
      warning: "",
      error: "",
      success: "",
      toolTitle: "",
      text: "#ff00ff",
    }),
  );
  const foregroundAt = (line: string, offset: number) =>
    [...line.slice(0, offset).matchAll(/\x1b\[(39|38;[0-9;]+)m/g)].at(-1)?.[1];
  for (const active of [false, true]) {
    for (const phase of [0, 600, 2400]) {
      for (const [status, glyph] of [
        ["running", "●"],
        ["error", "x"],
        ["done", "✓"],
        ["idle", "?"],
      ] as const) {
        const state = createInitialState("/repo");
        const tab = createTab(1, "worker", "/repo", {
          title: "Worker",
          status,
          activatedAt: Date.now() - phase,
        });
        if (status === "idle") tab.extensionUi.waitingForInputs = [{ id: "q", kind: "custom" }];
        state.tabs.push(tab);
        state.activeTabId = active ? tab.sessionId : "home";
        const line = renderTabBar(state, 100, theme)[0]!;
        // Locate the status in plain text first: Home may contain the ASCII error glyph.
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
        assert.ok(plain.includes(`${glyph} Worker`));
        const titleOffset = line.indexOf("Worker");
        const glyphOffset = line.lastIndexOf(glyph, titleOffset < 0 ? line.length : titleOffset);
        assert.equal(
          foregroundAt(line, glyphOffset),
          "39",
          `${status}, active=${active}, phase=${phase}`,
        );
        if (!active || phase === 2400) {
          const expected =
            status === "done" ? "39" : active ? "38;2;255;0;255" : "38;2;136;136;136";
          assert.equal(
            foregroundAt(line, titleOffset),
            expected,
            "status color must not leak into title",
          );
        }
      }
    }
  }
});

test("themeForId caches third-party adapters", () => {
  registerAdditionalTheme(sampleTheme("cache-me"));
  const a = themeForId("cache-me");
  const b = themeForId("cache-me");
  assert.equal(a, b);
});
