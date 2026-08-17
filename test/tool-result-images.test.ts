import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCapabilities, stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { toolExecutionToChatLine } from "../src/agent/runtime-tool-chat.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";

// 1x1 PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeRuntimeTab(settingsManager: SettingsManager): RuntimeTab {
  const definition = {
    name: "read",
    label: "Read",
    description: "test",
    parameters: {} as never,
    // Minimal renderers so the tool path uses renderResult + image strip.
    renderCall: () => ({
      render: () => ["read call"],
    }),
    renderResult: (
      _result: unknown,
      _options: unknown,
      _theme: unknown,
      context: { showImages: boolean },
    ) => ({
      render: () => [`result showImages=${context.showImages}`],
    }),
  };
  return {
    chat: [],
    tab: {
      workdir: "/tmp",
      extensionUi: { toolsExpanded: false },
    },
    agentSession: {
      settingsManager,
      getToolDefinition: () => definition,
    },
    requestRender: () => undefined,
  } as unknown as RuntimeTab;
}

test("tool result image strip respects showImages and imageWidthCells", () => {
  const sm = SettingsManager.inMemory();
  sm.setShowImages(true);
  sm.setImageWidthCells(20);
  const runtimeTab = fakeRuntimeTab(sm);
  const line = toolExecutionToChatLine(runtimeTab, {
    toolCallId: "t1",
    toolName: "read",
    status: "success",
    text: "ok",
    args: { path: "x.png" },
    result: {
      content: [
        { type: "text", text: "Read image file" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
      isError: false,
    },
    isPartial: false,
  });

  const shown = line.renderToolResult?.(40) ?? [];
  const plainShown = stripAnsi(shown.join("\n"));
  assert.match(plainShown, /result showImages=true/);
  // Pi only mounts Image when the terminal reports image caps.
  if (getCapabilities().images) {
    assert.ok(
      shown.length > 1,
      `expected image strip after result body, got: ${JSON.stringify(plainShown)}`,
    );
  } else {
    assert.equal(shown.length, 1, "no image strip without terminal image caps");
  }

  sm.setShowImages(false);
  const hidden = line.renderToolResult?.(40) ?? [];
  const plainHidden = stripAnsi(hidden.join("\n"));
  assert.match(plainHidden, /result showImages=false/);
  // showImages=false must not append an image strip regardless of caps.
  assert.equal(hidden.length, 1, `expected body only when hidden: ${JSON.stringify(plainHidden)}`);
});
