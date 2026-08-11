import "./helpers/isolated-agent-dir.js";
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseContextLimitValue,
  contextLimitPickerItems,
  applyContextLimit,
  applyContextLimitToSession,
  adjustCompactionSettingsForLimit,
  syncContextLimitToSessionModel,
} from "../src/core/context-limit.js";
import type { MixCodeTabInfo } from "../src/core/types.js";
import { createTab } from "../src/core/defaults.js";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";

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
    pendingFollowUps: [],
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
      waitingForInputs: [],
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

describe("adjustCompactionSettingsForLimit", () => {
  it("keeps compaction budgets below very small overridden limits", () => {
    const overrides: Array<{ compaction?: { reserveTokens?: number; keepRecentTokens?: number } }> = [];
    adjustCompactionSettingsForLimit({ applyOverrides: (override) => overrides.push(override) }, 1000, true);
    assert.deepEqual(overrides, [{ compaction: { reserveTokens: 100, keepRecentTokens: 250 } }]);
  });

  it("rejects reset when the manager baseline was not captured", () => {
    const settingsManager = { applyOverrides: () => undefined };
    assert.throws(
      () => adjustCompactionSettingsForLimit(settingsManager, 1000, false),
      /Compaction baseline was not captured/,
    );
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
    assert.equal(tab.toast?.type, "warning");
    assert.ok(tab.toast?.message.includes("model"));
  });

  it("shows success toast for normal values", () => {
    const tab = createMockTab();
    applyContextLimit(tab, 64000);
    assert.equal(tab.toast?.type, "success");
    assert.ok(!tab.toast?.message.includes("exceeds"));
  });
});

describe("syncContextLimitToSessionModel / applyContextLimitToSession", () => {
  it("writes the UI limit into the live session model.contextWindow", () => {
    const tab = createMockTab();
    const sessionModel = { contextWindow: 131_072 };
    applyContextLimit(tab, 32_000);
    syncContextLimitToSessionModel(tab, sessionModel);
    assert.equal(sessionModel.contextWindow, 32_000);
  });

  it("restores the canonical model window on reset", () => {
    const tab = createMockTab({ contextLimit: 32_000, contextLimitOverridden: true });
    const sessionModel = { contextWindow: 32_000 };
    applyContextLimit(tab, "reset");
    syncContextLimitToSessionModel(tab, sessionModel);
    assert.equal(sessionModel.contextWindow, 131_072);
  });

  it("applies limit + session model + compaction budgets together", () => {
    const tab = createMockTab();
    const sessionModel = { contextWindow: 131_072 };
    const overrides: Array<{ compaction?: { reserveTokens?: number; keepRecentTokens?: number } }> =
      [];
    applyContextLimitToSession(tab, 8_000, {
      model: sessionModel,
      settingsManager: { applyOverrides: (override) => overrides.push(override) },
    });
    assert.equal(tab.contextLimit, 8_000);
    assert.equal(tab.contextLimitOverridden, true);
    assert.equal(sessionModel.contextWindow, 8_000);
    assert.deepEqual(overrides, [{ compaction: { reserveTokens: 800, keepRecentTokens: 2000 } }]);
  });
});

test("session context limits do not mutate another session's model", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-context-limit-model-isolation-"));
  try {
    const sharedModel = {
      ...MIXCODE_FAUX_MODEL,
      provider: "context-limit-shared",
      api: "context-limit-shared",
      id: "context-limit-shared",
      contextWindow: 128_000,
    };
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, agentDir: dir });
    const first = await runtime.createTab(createTab(1, "first", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
      model: sharedModel,
    });
    const second = await runtime.createTab(createTab(2, "second", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
      model: sharedModel,
    });

    applyContextLimitToSession(first.tab, 32_000, {
      model: first.agentSession.model,
      settingsManager: first.agentSession.settingsManager,
    });

    assert.equal(first.agentSession.model?.contextWindow, 32_000);
    assert.equal(second.agentSession.model?.contextWindow, 128_000);
    assert.equal(second.tab.contextLimit, 128_000);
    assert.equal(sharedModel.contextWindow, 128_000);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("refreshTabStatus keeps canonical capacity so context-limit reset works", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-context-limit-refresh-reset-"));
  try {
    const model = {
      ...MIXCODE_FAUX_MODEL,
      provider: "context-limit-refresh",
      api: "context-limit-refresh",
      id: "context-limit-refresh",
      contextWindow: 128_000,
    };
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, agentDir: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
      model,
    });

    applyContextLimitToSession(runtimeTab.tab, 32_000, {
      model: runtimeTab.agentSession.model,
      settingsManager: runtimeTab.agentSession.settingsManager,
    });
    assert.equal(runtimeTab.tab.model.contextWindow, 128_000);
    assert.equal(runtimeTab.agentSession.model?.contextWindow, 32_000);

    runtime.refreshTabStatus("s1");
    assert.equal(runtimeTab.tab.contextLimitOverridden, true);
    assert.equal(runtimeTab.tab.contextLimit, 32_000);
    assert.equal(runtimeTab.tab.model.contextWindow, 128_000);
    assert.equal(runtimeTab.agentSession.model?.contextWindow, 32_000);

    applyContextLimitToSession(runtimeTab.tab, "reset", {
      model: runtimeTab.agentSession.model,
      settingsManager: runtimeTab.agentSession.settingsManager,
    });
    assert.equal(runtimeTab.tab.contextLimitOverridden, false);
    assert.equal(runtimeTab.tab.contextLimit, 128_000);
    assert.equal(runtimeTab.tab.model.contextWindow, 128_000);
    assert.equal(runtimeTab.agentSession.model?.contextWindow, 128_000);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
