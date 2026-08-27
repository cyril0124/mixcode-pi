import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCapabilities, stripTerminalSequences as stripAnsi, Text } from "@earendil-works/pi-tui";
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
      options: { expanded: boolean },
      _theme: unknown,
      context: { showImages: boolean },
    ) => ({
      render: () => [`result showImages=${context.showImages} expanded=${options.expanded}`],
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

test("running tool rows always mark ToolExecutionComponent execution started", () => {
  const sm = SettingsManager.inMemory();
  const definition = {
    name: "bash",
    label: "bash",
    description: "test",
    parameters: {} as never,
    renderCall: (
      _args: unknown,
      _theme: unknown,
      context: { executionStarted: boolean; isPartial: boolean },
    ) => new Text(`started=${context.executionStarted} partial=${context.isPartial}`, 0, 0),
  };
  const runtimeTab = {
    chat: [],
    tab: { workdir: "/tmp", extensionUi: { toolsExpanded: false } },
    agentSession: {
      settingsManager: sm,
      getToolDefinition: () => definition,
    },
    requestRender: () => undefined,
  } as unknown as RuntimeTab;
  const previous = toolExecutionToChatLine(runtimeTab, {
    toolCallId: "spinner",
    toolName: "bash",
    status: "pending",
    text: "",
    args: { command: "sleep 10" },
    isPartial: true,
  });
  // Reproduce a reconstructed line whose status already says running while
  // the reused component has not received markExecutionStarted yet.
  previous.status = "running";

  const running = toolExecutionToChatLine(runtimeTab, {
    toolCallId: "spinner",
    toolName: "bash",
    status: "running",
    text: "",
    args: { command: "sleep 10" },
    isPartial: true,
    previous,
  });
  const rendered = stripAnsi((running.renderToolCall?.(80) ?? []).join("\n"));
  assert.match(rendered, /started=true partial=true/);
});

test("tool row re-reads Ctrl+O expansion state on every render", () => {
  const sm = SettingsManager.inMemory();
  const runtimeTab = fakeRuntimeTab(sm);
  const line = toolExecutionToChatLine(runtimeTab, {
    toolCallId: "expand",
    toolName: "read",
    status: "success",
    text: "ok",
    args: { path: "x.txt" },
    result: {
      content: [{ type: "text", text: "content" }],
      isError: false,
    },
    isPartial: false,
  });

  const collapsed = stripAnsi((line.renderToolCall?.(60) ?? []).join("\n"));
  assert.match(collapsed, /expanded=false/);

  runtimeTab.tab.extensionUi.toolsExpanded = true;
  const expanded = stripAnsi((line.renderToolCall?.(60) ?? []).join("\n"));
  assert.match(expanded, /expanded=true/);
});

test("tool result image strip respects showImages and imageWidthCells", () => {
  const sm = SettingsManager.inMemory();
  sm.setShowImages(true);
  sm.setImageWidthCells(20);
  const runtimeTab = fakeRuntimeTab(sm);
  const options = {
    toolCallId: "t1",
    toolName: "read",
    status: "success" as const,
    text: "ok",
    args: { path: "x.png" },
    result: {
      content: [
        { type: "text" as const, text: "Read image file" },
        { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
      isError: false,
    },
    isPartial: false,
  };
  const line = toolExecutionToChatLine(runtimeTab, options);

  const shown = line.renderToolCall?.(40) ?? [];
  const plainShown = stripAnsi(shown.join("\n"));
  assert.match(plainShown, /result showImages=true/);
  // ToolExecutionComponent owns its default shell, so compare image-strip
  // deltas rather than assuming a one-line renderer body.

  sm.setShowImages(false);
  const hiddenLine = toolExecutionToChatLine(runtimeTab, { ...options, previous: line });
  const hidden = hiddenLine.renderToolCall?.(40) ?? [];
  const plainHidden = stripAnsi(hidden.join("\n"));
  assert.match(plainHidden, /result showImages=false/);
  if (getCapabilities().images) {
    assert.ok(shown.length > hidden.length, "visible image strip must add rendered rows");
  } else {
    assert.equal(shown.length, hidden.length, "without image caps both paths have the same shell");
  }
});
