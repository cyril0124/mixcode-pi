import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseContextLimitValue,
  contextLimitPickerItems,
  applyContextLimit,
} from "../src/core/context-limit.js";
import type { MixCodeTabInfo } from "../src/core/types.js";

function createMockTab(overrides: Partial<MixCodeTabInfo> = {}): MixCodeTabInfo {
  return {
    index: 0,
    sessionId: "test-session",
    title: "Test",
    status: "idle",
    tokenInput: 0,
    tokenOutput: 0,
    contextLimit: 131_072,
    currentContextTokens: undefined,
    model: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      displayName: "anthropic/claude-sonnet-4-20250514",
      contextWindow: 131_072,
    },
    thinkingLevel: "off",
    workdir: "/tmp",
    alias: "",
    pendingDialogs: [],
    pendingMessages: [],
    promptHistory: [],
    draftInput: "",
    chatScrollOffset: 0,
    previewOpen: false,
    previewMessages: [],
    previewIndex: 0,
    previewScrollOffset: 0,
    previewHint: "",
    vimMode: false,
    unreadDone: false,
    extensionUi: {
      statuses: [],
      widgets: [],
      toolsExpanded: false,
      pendingUserInteractions: [],
      workingVisible: false,
    },
    ...overrides,
  };
}

describe("parseContextLimitValue", () => {
  it("parses plain numbers", () => {
    assert.equal(parseContextLimitValue("32000"), 32000);
    assert.equal(parseContextLimitValue("1024"), 1024);
    assert.equal(parseContextLimitValue("200000"), 200000);
  });

  it("parses k suffix", () => {
    assert.equal(parseContextLimitValue("32k"), 32000);
    assert.equal(parseContextLimitValue("32K"), 32000);
    assert.equal(parseContextLimitValue("128k"), 128000);
    assert.equal(parseContextLimitValue("64k"), 64000);
  });

  it("parses decimal k values", () => {
    assert.equal(parseContextLimitValue("32.5k"), 32500);
    assert.equal(parseContextLimitValue("1.5k"), 1500);
  });

  it("handles reset keyword", () => {
    assert.equal(parseContextLimitValue("reset"), "reset");
    assert.equal(parseContextLimitValue("RESET"), "reset");
    assert.equal(parseContextLimitValue("  reset  "), "reset");
  });

  it("returns undefined for invalid input", () => {
    assert.equal(parseContextLimitValue(""), undefined);
    assert.equal(parseContextLimitValue("abc"), undefined);
    assert.equal(parseContextLimitValue("-100"), undefined);
    assert.equal(parseContextLimitValue("0"), undefined);
    assert.equal(parseContextLimitValue("0k"), undefined);
  });

  it("trims whitespace", () => {
    assert.equal(parseContextLimitValue("  32k  "), 32000);
    assert.equal(parseContextLimitValue("  128000  "), 128000);
  });
});

describe("contextLimitPickerItems", () => {
  it("generates items based on model context window", () => {
    const items = contextLimitPickerItems(128_000);
    assert.equal(items.length, 5);
    assert.equal(items[0]!.id, "32000");
    assert.equal(items[0]!.description, "¼ of model capacity");
    assert.equal(items[1]!.id, "64000");
    assert.equal(items[1]!.description, "½ of model capacity");
    assert.equal(items[2]!.id, "96000");
    assert.equal(items[2]!.description, "¾ of model capacity");
    assert.equal(items[3]!.id, "reset");
    assert.equal(items[3]!.description, "Full (reset to default)");
    assert.equal(items[4]!.id, "custom");
    assert.equal(items[4]!.description, "Enter a custom value...");
  });

  it("handles odd context window sizes", () => {
    const items = contextLimitPickerItems(200_000);
    assert.equal(items[0]!.id, "50000");
    assert.equal(items[1]!.id, "100000");
    assert.equal(items[2]!.id, "150000");
  });
});

describe("applyContextLimit", () => {
  it("sets context limit and marks as overridden", () => {
    const tab = createMockTab();
    applyContextLimit(tab, 32000);
    assert.equal(tab.contextLimit, 32000);
    assert.equal(tab.contextLimitOverridden, true);
    assert.ok(tab.toast?.message.includes("32k"));
  });

  it("resets context limit to model default", () => {
    const tab = createMockTab({ contextLimit: 32000, contextLimitOverridden: true });
    applyContextLimit(tab, "reset");
    assert.equal(tab.contextLimit, 131_072);
    assert.equal(tab.contextLimitOverridden, false);
    assert.ok(tab.toast?.message.includes("reset"));
  });

  it("shows warning toast when exceeding model capacity", () => {
    const tab = createMockTab();
    applyContextLimit(tab, 200_000);
    assert.equal(tab.contextLimit, 200_000);
    assert.equal(tab.contextLimitOverridden, true);
    assert.ok(tab.toast?.message.includes("⚠"));
    assert.ok(tab.toast?.message.includes("model"));
  });

  it("shows success toast for normal values", () => {
    const tab = createMockTab();
    applyContextLimit(tab, 64000);
    assert.ok(tab.toast?.message.includes("✓"));
    assert.ok(!tab.toast?.message.includes("exceeds"));
  });
});
