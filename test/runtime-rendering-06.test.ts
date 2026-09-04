import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { syncAssistantBlocks, updateStreamingAssistant } from "../src/agent/runtime-events.js";
import { toolExecutionToChatLine } from "../src/agent/runtime-tool-chat.js";
import {
  createTab,
  padLine,
  renderConversation,
  renderInputMeta,
  renderWorkingIndicator,
} from "./helpers/mixcode.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("padLine strips control sequences, expands tabs, and fits width", () => {
  assert.equal(padLine("\x01ok\x02", 6), "ok    ");
  assert.match(padLine("\x1bPpayload\x1b\\ok", 6), /ok/);
  const tabbed = padLine("file.ts:1:\t\tthis.ui.invalidate();", 40);
  assert.equal(tabbed.includes("\t"), false);
  assert.equal(visibleWidth(tabbed), 40);
});

test("tool chat lines stay within width and drop clear-screen controls", () => {
  const cleared = renderConversation(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        args: { command: "\x1b[2J\x1b[Hprintf ok" },
        text: "\x1b]0;title\x07ok\x1b_Gbad\x07",
      },
    ],
    40,
  ).join("\n");
  assert.equal(cleared.includes("\x1b[2J"), false);
  assert.match(stripAnsi(cleared), /ok/);

  const toolBlock = renderConversation(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        args: { command: "cat package.json" },
        text: '{\n  "name": "mixcode-pi"\n}',
      },
    ],
    48,
  );
  assert.equal(
    toolBlock.every((line) => visibleWidth(line) === 48),
    true,
  );
});

test("custom tool renderers receive content width; self shell skips paint frame", () => {
  const widths: number[] = [];
  const custom = renderConversation(
    [
      {
        role: "tool",
        title: "custom",
        status: "success",
        text: "fallback",
        renderToolCall: (width) => {
          widths.push(width);
          return ["call one", "result one"];
        },
      },
    ],
    24,
  );
  assert.deepEqual(widths, [22]);
  assert.match(stripAnsi(custom.join("\n")), /call one[\s\S]*result one/);

  const self = stripAnsi(
    renderConversation(
      [
        {
          role: "tool",
          title: "self-rendered",
          status: "success",
          text: "fallback",
          toolRenderShell: "self",
          renderToolCall: () => ["self call", "self result"],
        },
      ],
      24,
    ).join("\n"),
  );
  assert.match(self, /self call/);
  assert.match(self, /self result/);
});

test("tool block keeps exactly one blank row below the previous block", () => {
  const sm = SettingsManager.inMemory();
  const runtimeTab = testRuntimeTab({
    chat: [],
    tab: createTab(1, "s1", "/tmp"),
    agentSession: {
      settingsManager: sm,
      getToolDefinition: () => ({
        name: "agent",
        label: "agent",
        description: "test",
        parameters: Type.Object({}),
        execute: () => assert.fail("rendering must not execute the tool"),
        renderCall: () => ({ render: () => ["agent call"], invalidate: () => undefined }),
      }),
    },
    requestRender: () => undefined,
  });
  const toolLine = toolExecutionToChatLine(runtimeTab, {
    toolCallId: "spacing",
    toolName: "agent",
    status: "success",
    text: "done",
    args: {},
    isPartial: false,
  });

  const lines = renderConversation([{ role: "assistant", text: "answer" }, toolLine], 40).map(
    stripAnsi,
  );
  const answerRow = lines.findIndex((line) => line.includes("answer"));
  const callRow = lines.findIndex((line) => line.includes("agent call"));
  assert.ok(answerRow >= 0 && callRow > answerRow, "both blocks must render");
  const gap = lines.slice(answerRow + 1, callRow).filter((line) => line.trim() === "");
  // One chat separator + one background pad row inside the tool frame.
  assert.equal(gap.length, 2);
  assert.equal(callRow - answerRow, 3);
});

test("consecutive thinking blocks render as one Pi thinking section", () => {
  const runtimeTab = testRuntimeTab({ chat: [], streamingAssistant: undefined });
  syncAssistantBlocks(runtimeTab, {
    ...fauxAssistantMessage(""),
    content: [
      { type: "thinking", thinking: "first reasoning block" },
      { type: "thinking", thinking: "second reasoning block" },
      { type: "text", text: "answer" },
    ],
  });

  const [thinkingLine, assistantLine] = runtimeTab.chat;
  assert.equal(thinkingLine?.role, "thinking");
  assert.equal(thinkingLine?.text, "first reasoning block\n\nsecond reasoning block");
  assert.ok(Number.isFinite(thinkingLine?.thinkingStartedAt));
  assert.deepEqual(assistantLine, { role: "assistant", text: "answer" });
});

test("live thinking updates carry the timer stamps and message_end freezes them", () => {
  const runtimeTab = testRuntimeTab({
    tab: createTab(1, "s1", "/repo"),
    chat: [],
    streamingAssistant: undefined,
  });
  const message = {
    ...fauxAssistantMessage(""),
    content: [{ type: "thinking", thinking: "partial reasoning" }],
  } satisfies AssistantMessage;

  updateStreamingAssistant(runtimeTab, message);
  const startedAt = runtimeTab.chat[0]?.thinkingStartedAt;
  assert.ok(Number.isFinite(startedAt));
  assert.equal(runtimeTab.chat[0]?.thinkingEndedAt, undefined);

  // Streaming growth replaces the line object in place; stamps must survive.
  updateStreamingAssistant(runtimeTab, {
    ...message,
    content: [{ type: "thinking", thinking: "partial reasoning, now longer" }],
  } satisfies AssistantMessage);
  assert.equal(runtimeTab.chat[0]?.thinkingStartedAt, startedAt);
  assert.equal(runtimeTab.chat[0]?.thinkingEndedAt, undefined);

  updateStreamingAssistant(runtimeTab, message, { final: true });
  const ended = runtimeTab.chat[0]?.thinkingEndedAt;
  assert.ok(Number.isFinite(ended));
  assert.ok(ended! >= startedAt!);
  assert.equal(runtimeTab.streamingAssistant, undefined);
});

test("a tool call after thinking freezes that thinking timer mid-message", () => {
  const runtimeTab = testRuntimeTab({
    tab: createTab(1, "s1", "/repo"),
    chat: [],
    streamingAssistant: undefined,
    agentSession: {
      getToolDefinition: () => undefined,
      settingsManager: SettingsManager.inMemory(),
    },
  });
  const base = fauxAssistantMessage("");
  updateStreamingAssistant(runtimeTab, {
    ...base,
    content: [{ type: "thinking", thinking: "deciding to call a tool" }],
  } satisfies AssistantMessage);
  assert.equal(runtimeTab.chat[0]?.thinkingEndedAt, undefined);

  updateStreamingAssistant(runtimeTab, {
    ...base,
    content: [
      { type: "thinking", thinking: "deciding to call a tool" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
    ],
  } satisfies AssistantMessage);
  assert.ok(runtimeTab.chat[0]?.thinkingEndedAt !== undefined);
  assert.ok(runtimeTab.chat[0]!.thinkingEndedAt! >= runtimeTab.chat[0]!.thinkingStartedAt!);
});

test("interleaved thinking groups each freeze when a later block appears", () => {
  const runtimeTab = testRuntimeTab({
    tab: createTab(1, "s1", "/repo"),
    chat: [],
    streamingAssistant: undefined,
    agentSession: {
      getToolDefinition: () => undefined,
      settingsManager: SettingsManager.inMemory(),
    },
  });
  const base = fauxAssistantMessage("");
  syncAssistantBlocks(runtimeTab, {
    ...base,
    content: [
      { type: "thinking", thinking: "first group" },
      { type: "text", text: "partial" },
      { type: "thinking", thinking: "second group" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
    ],
  } satisfies AssistantMessage);
  const first = runtimeTab.chat[0];
  const second = runtimeTab.chat[2];
  assert.ok(first?.thinkingEndedAt !== undefined);
  assert.ok(second?.thinkingEndedAt !== undefined);
});

test("error system messages show error text without a System label", () => {
  const error = stripAnsi(
    renderConversation([{ role: "system", text: "Error: 503 Service Unavailable" }], 60).join("\n"),
  );
  assert.match(error, /Error: 503 Service Unavailable/);
  assert.doesNotMatch(error, /\[System\]:/);

  const plain = stripAnsi(
    renderConversation([{ role: "system", text: "Just a note" }], 60).join("\n"),
  );
  assert.match(plain, /Just a note/);
  assert.doesNotMatch(plain, /\[System\]:/);
});

test("system markdown tables render as visible table text", () => {
  const plain = stripAnsi(
    renderConversation(
      [
        {
          role: "system",
          text: [
            "**Hotkeys**",
            "",
            "| Key | Action |",
            "|-----|--------|",
            "| `/` | Slash commands |",
          ].join("\n"),
        },
      ],
      60,
    ).join("\n"),
  );
  assert.match(plain, /Hotkeys/);
  assert.match(plain, /Key/);
  assert.match(plain, /Slash commands/);
  assert.doesNotMatch(plain, /\|-----\|--------\|/);
});

test("narrow input meta stays width-bounded and keeps a models hit region", () => {
  const tab = createTab(1, "s1", "/repo/" + "long/".repeat(8), {
    pendingMessages: ["queued"],
    pendingEscapeArmedAt: 1_700_000_000_000,
  });
  const line = renderInputMeta(tab, 28).join("\n");
  assert.equal(visibleWidth(line), 27);
  const regions = tab.inputMetaHitRegions;
  assert.ok(regions);
  assert.ok(regions.some((region) => region.action === "models"));
  // Which chips survive the narrow-width compactor is layout policy, but every
  // emitted hit target must sit inside the line it was painted on: a region
  // past the right edge is a click target the user can never reach.
  assert.ok(regions.every((region) => region.startX >= 0 && region.endX <= 27));
});

test("blank custom working message still shows Working duration", () => {
  const plain = stripAnsi(
    renderWorkingIndicator(
      createTab(1, "s1", "/repo", {
        status: "running",
        extensionUi: {
          statuses: [],
          widgets: [],
          toolsExpanded: false,
          waitingForInputs: [],
          workingVisible: true,
          workingMessage: "   ",
        },
      }),
      80,
      new Date("2026-05-10T00:00:00.000Z"),
    ).join("\n"),
  );
  assert.match(plain, /Working \(0s/);
});
