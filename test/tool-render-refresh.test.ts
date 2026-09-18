import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ChatLine } from "../src/agent/runtime-types.js";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { toolExecutionToChatLine } from "../src/agent/runtime-tool-chat.js";
import { createTab } from "../src/core/defaults.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";

test("renderer invalidation refreshes the current row after pending and partial replacements", () => {
  let context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] | undefined;
  let frame = 0;
  let redraws = 0;
  const definition: ToolDefinition = {
    name: "animated_tool",
    label: "Animated tool",
    description: "Renders an externally advanced frame.",
    parameters: {} as never,
    execute: async () => ({ content: [], details: {} }),
    renderCall: (_args, _theme, nextContext) => {
      context = nextContext;
      return new Text(nextContext.isPartial ? `frame-${frame}` : "completed", 0, 0);
    },
    renderResult: (result) =>
      new Text(
        result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
        0,
        0,
      ),
  };
  const runtimeTab = testRuntimeTab({
    tab: createTab(1, "animated", "/tmp"),
    agentSession: {
      settingsManager: SettingsManager.inMemory(),
      getToolDefinition: () => definition,
    },
    requestRender: () => {
      redraws += 1;
    },
  });
  const options = {
    toolCallId: "animated-call",
    toolName: definition.name,
    text: "",
    args: {},
    isPartial: true,
  };
  const render = (line: ChatLine) => stripTerminalSequences(renderChatBlock(line, 80).join("\n"));
  let line = toolExecutionToChatLine(runtimeTab, { ...options, status: "pending" });
  assert.match(render(line), /frame-0/);

  for (const output of [undefined, "live-one", "live-one\nlive-two"]) {
    line = toolExecutionToChatLine(runtimeTab, {
      ...options,
      status: "running",
      previous: line,
      result:
        output === undefined
          ? undefined
          : {
              content: [{ type: "text", text: output }],
              isError: false,
            },
    });
    assert.match(render(line), new RegExp(`frame-${frame}`));
    if (output) {
      for (const outputLine of output.split("\n")) assert.ok(render(line).includes(outputLine));
    }
    const beforeRedraws = redraws;
    frame += 1;
    assert.ok(context);
    context.invalidate();
    assert.ok(redraws > beforeRedraws, "invalidation requests a host repaint");
    assert.match(render(line), new RegExp(`frame-${frame}`));
  }

  line = toolExecutionToChatLine(runtimeTab, {
    ...options,
    status: "success",
    previous: line,
    result: { content: [{ type: "text", text: "final-output" }], isError: false },
    isPartial: false,
  });
  assert.match(render(line), /completed[\s\S]*final-output/);
  assert.doesNotMatch(render(line), /frame-|live-one|live-two/);
});
