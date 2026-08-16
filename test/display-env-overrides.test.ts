import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { renderInputMeta } from "../src/ui/rendering/chrome.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("Display environment overrides", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MIXCODE_DISPLAY_MODEL;
    delete process.env.MIXCODE_DISPLAY_THINKING;
    delete process.env.MIXCODE_DISPLAY_WORKDIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("renders default model, thinking, and workdir when env vars are unset", () => {
    const tab = createTab(1, "s1", "/original/path/to/project", {
      model: {
        provider: "anthropic",
        modelId: "claude-3-7-sonnet",
        displayName: "anthropic/claude-3-7-sonnet",
        contextWindow: 200_000,
      },
      thinkingLevel: "medium",
    });
    const text = stripAnsi(renderInputMeta(tab, 120, 0, undefined, true, "nerd").join("\n"));
    assert.match(text, /claude-3-7-sonnet/);
    assert.match(text, /Medium/);
    assert.match(text, /project/);
  });

  it("overrides displayed model name with MIXCODE_DISPLAY_MODEL", () => {
    process.env.MIXCODE_DISPLAY_MODEL = "custom-provider/custom-model";
    const tab = createTab(1, "s1", "/original/path/to/project", {
      model: {
        provider: "anthropic",
        modelId: "claude-3-7-sonnet",
        displayName: "anthropic/claude-3-7-sonnet",
        contextWindow: 200_000,
      },
      thinkingLevel: "medium",
    });
    const text = stripAnsi(renderInputMeta(tab, 120, 0, undefined, true, "nerd").join("\n"));
    assert.match(text, /custom-model/);
    assert.doesNotMatch(text, /claude-3-7-sonnet/);
  });

  it("overrides displayed thinking text with MIXCODE_DISPLAY_THINKING", () => {
    process.env.MIXCODE_DISPLAY_THINKING = "DeepThinking";
    const tab = createTab(1, "s1", "/original/path/to/project", {
      model: {
        provider: "anthropic",
        modelId: "claude-3-7-sonnet",
        displayName: "anthropic/claude-3-7-sonnet",
        contextWindow: 200_000,
      },
      thinkingLevel: "medium",
    });
    const text = stripAnsi(renderInputMeta(tab, 120, 0, undefined, true, "nerd").join("\n"));
    assert.match(text, /DeepThinking/);
    assert.doesNotMatch(text, /Medium/);
  });

  it("overrides displayed workdir with MIXCODE_DISPLAY_WORKDIR", () => {
    process.env.MIXCODE_DISPLAY_WORKDIR = "/virtual/workspace/demo";
    const tab = createTab(1, "s1", "/original/path/to/project", {
      model: {
        provider: "anthropic",
        modelId: "claude-3-7-sonnet",
        displayName: "anthropic/claude-3-7-sonnet",
        contextWindow: 200_000,
      },
      thinkingLevel: "medium",
    });
    const text = stripAnsi(renderInputMeta(tab, 120, 0, undefined, true, "nerd").join("\n"));
    assert.match(text, /demo/);
    assert.doesNotMatch(text, /project/);
  });

  it("overrides all three simultaneously", () => {
    process.env.MIXCODE_DISPLAY_MODEL = "secret-model";
    process.env.MIXCODE_DISPLAY_THINKING = "High";
    process.env.MIXCODE_DISPLAY_WORKDIR = "/masked/dir";
    const tab = createTab(1, "s1", "/original/path/to/project", {
      model: {
        provider: "anthropic",
        modelId: "claude-3-7-sonnet",
        displayName: "anthropic/claude-3-7-sonnet",
        contextWindow: 200_000,
      },
      thinkingLevel: "medium",
    });
    const text = stripAnsi(renderInputMeta(tab, 120, 0, undefined, true, "nerd").join("\n"));
    assert.match(text, /secret-model/);
    assert.match(text, /High/);
    assert.match(text, /dir/);
    assert.doesNotMatch(text, /claude-3-7-sonnet/);
    assert.doesNotMatch(text, /Medium/);
    assert.doesNotMatch(text, /project/);
  });
});
