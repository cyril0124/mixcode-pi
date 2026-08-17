import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isGenericAbortMessage,
  surfaceAssistantStopReason,
} from "../src/agent/runtime-chat.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";

function emptyTab(): RuntimeTab {
  return {
    chat: [],
    tab: { previewMessages: [], previewIndex: 0 },
  } as unknown as RuntimeTab;
}

function abortedAssistant(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "aborted",
    errorMessage,
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  } as unknown as AssistantMessage;
}

function errorAssistant(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  } as unknown as AssistantMessage;
}

function lengthAssistant(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "length",
    content,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  } as unknown as AssistantMessage;
}

const TRUNCATED_NOTICE = "Response was truncated before completion.";

test("isGenericAbortMessage matches provider boilerplate", () => {
  assert.equal(isGenericAbortMessage(undefined), true);
  assert.equal(isGenericAbortMessage("Request was aborted"), true);
  assert.equal(isGenericAbortMessage("Request aborted"), true);
  assert.equal(isGenericAbortMessage("Operation aborted"), true);
  assert.equal(isGenericAbortMessage("The operation was aborted"), true);
  assert.equal(isGenericAbortMessage("The operation was aborted."), true);
  assert.equal(isGenericAbortMessage("model timeout"), false);
});

test("empty generic abort does not append a system line", () => {
  const tab = emptyTab();
  surfaceAssistantStopReason(tab, abortedAssistant("Request was aborted"));
  surfaceAssistantStopReason(tab, abortedAssistant("Request aborted"));
  surfaceAssistantStopReason(tab, abortedAssistant("The operation was aborted."));
  assert.equal(tab.chat.length, 0);
});

test("empty error abort still surfaces as Error (host does not guess abort from error)", () => {
  const tab = emptyTab();
  surfaceAssistantStopReason(tab, errorAssistant("The operation was aborted."));
  assert.equal(tab.chat.length, 1);
  assert.equal(tab.chat[0]?.text, "Error: The operation was aborted.");
});

test("empty non-generic error still surfaces the provider message", () => {
  const tab = emptyTab();
  surfaceAssistantStopReason(tab, errorAssistant("model timeout"));
  assert.equal(tab.chat.length, 1);
  assert.equal(tab.chat[0]?.role, "system");
  assert.equal(tab.chat[0]?.text, "Error: model timeout");
});

test("empty error with no message still surfaces Unknown error", () => {
  const tab = emptyTab();
  surfaceAssistantStopReason(tab, errorAssistant(""));
  assert.equal(tab.chat.length, 1);
  assert.equal(tab.chat[0]?.text, "Error: Unknown error");
});

test("empty non-generic abort still surfaces the provider message", () => {
  const tab = emptyTab();
  surfaceAssistantStopReason(tab, abortedAssistant("upstream cancelled stream"));
  assert.equal(tab.chat.length, 1);
  assert.equal(tab.chat[0]?.role, "system");
  assert.match(tab.chat[0]?.text ?? "", /upstream cancelled stream/);
});

test("length stop always surfaces Pi truncation notice, even with assistant text", () => {
  const tab = emptyTab();
  surfaceAssistantStopReason(
    tab,
    lengthAssistant([{ type: "text", text: "partial answer" }]),
  );
  assert.equal(tab.chat.length, 1);
  assert.equal(tab.chat[0]?.role, "system");
  assert.equal(tab.chat[0]?.text, TRUNCATED_NOTICE);
  assert.equal(tab.chat[0]?.variant, "system-error");
});

test("length stop with pending tools shows notice and does not mark tools cancelled", () => {
  const tab = emptyTab();
  tab.chat.push({
    role: "tool",
    title: "edit",
    status: "pending",
    toolCallId: "t1",
    text: "",
  });
  surfaceAssistantStopReason(tab, lengthAssistant([{ type: "text", text: "…" }]));
  assert.equal(tab.chat[0]?.role, "tool");
  assert.equal(tab.chat[0]?.status, "pending");
  assert.equal(tab.chat[1]?.role, "system");
  assert.equal(tab.chat[1]?.text, TRUNCATED_NOTICE);
  assert.equal(tab.chat[1]?.variant, "system-error");
});
