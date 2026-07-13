import assert from "node:assert/strict";
import { test } from "node:test";
import bashDefaultTimeoutExtension, { appendBashDefaultTimeoutNote } from "./index.js";

test("bash-default-timeout adds bash timeout note to system prompt", () => {
  const prompt = "system";
  const patched = appendBashDefaultTimeoutNote(prompt);
  assert.match(patched, /bash tool applies a default timeout of 300 seconds/);
  assert.equal(appendBashDefaultTimeoutNote(patched), patched);
});

test("bash-default-timeout patches missing bash tool timeout", async () => {
  type BashToolCall = {
    type: "tool_call";
    toolName: "bash";
    toolCallId: string;
    input: { command: string; timeout?: number };
  };
  const handlers: Record<string, Array<(event: BashToolCall) => void>> = {};
  bashDefaultTimeoutExtension({
    on: (event: string, handler: (event: BashToolCall) => void) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
  } as never);

  const event: BashToolCall = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "1",
    input: { command: "pwd" },
  };
  await handlers.tool_call?.[0]?.(event);
  assert.equal(event.input.timeout, 300);

  const explicit: BashToolCall = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "2",
    input: { command: "pwd", timeout: 12 },
  };
  await handlers.tool_call?.[0]?.(explicit);
  assert.equal(explicit.input.timeout, 12);
});
