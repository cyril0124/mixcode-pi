import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  MixCodeRuntime,
  createTab,
} from "./helpers/mixcode.js";

test("runtime surfaces assistant error and abort stop reasons", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-stop-reasons-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const emptyAssistant = {
      role: "assistant" as const,
      content: [] as Array<
        | { type: "text"; text: string }
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
      >,
      api: "x" as const,
      provider: "x" as const,
      model: "x",
      usage,
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: { ...emptyAssistant, stopReason: "error" as const, errorMessage: "provider failed" },
    });
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.text.includes("Error: provider failed"),
      ),
    );

    const toolAbort = {
      ...emptyAssistant,
      content: [
        {
          type: "toolCall" as const,
          id: "tc-abort",
          name: "bash",
          arguments: { command: "sleep 10" },
        },
      ],
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...emptyAssistant, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: toolAbort,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    });
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: toolAbort });
    const abortedTool = runtimeTab.chat.find(
      (line) => line.role === "tool" && line.toolCallId === "tc-abort",
    );
    assert.equal(abortedTool?.status, "error");
    // Generic provider abort wording is not shown as "Operation aborted"; tools get a calm label.
    assert.match(abortedTool?.text ?? "", /Cancelled/);

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: { ...emptyAssistant, stopReason: "error" as const },
    });
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.text.includes("Error: Unknown error"),
      ),
    );

    const customAbort = {
      ...toolAbort,
      content: [
        {
          type: "toolCall" as const,
          id: "tc-custom-abort",
          name: "bash",
          arguments: { command: "sleep 20" },
        },
      ],
      errorMessage: "User cancelled run",
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...emptyAssistant, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: customAbort,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    });
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: customAbort });
    const customAbortTool = runtimeTab.chat.find(
      (line) => line.role === "tool" && line.toolCallId === "tc-custom-abort",
    );
    assert.equal(customAbortTool?.text, "User cancelled run");

    const systemCount = runtimeTab.chat.filter((line) => line.role === "system").length;
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: {
        ...emptyAssistant,
        content: [{ type: "text" as const, text: "partial public answer" }],
        stopReason: "error" as const,
        errorMessage: "after text",
      },
    });
    assert.equal(runtimeTab.chat.filter((line) => line.role === "system").length, systemCount);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps assistant thinking out of chat assistant text", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-thinking-keep-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: dir });
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "private chain of thought" },
      { type: "text" as const, text: "public answer" },
    ],
    api: "x" as const,
    provider: "x" as const,
    model: "x",
    usage,
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  try {
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...message, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "private chain of thought",
        partial: {},
      },
    });
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message });

    // Thinking lands in chat as a dedicated thinking line, kept out of assistant text.
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["private chain of thought"],
    );
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "assistant").map((line) => line.text),
      ["public answer"],
    );
    assert.deepEqual(
      tab.previewMessages.filter((line) => line.role === "assistant").map((line) => line.text),
      ["public answer"],
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime streams thinking from partial assistant messages", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-thinking-stream-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: dir });
  const tab = createTab(1, "s1", process.cwd());
  try {
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const baseMessage = {
      role: "assistant" as const,
      content: [] as Array<{ type: "thinking"; thinking: string } | { type: "text"; text: string }>,
      api: "x" as const,
      provider: "x" as const,
      model: "x",
      usage,
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: baseMessage });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: { ...baseMessage, content: [{ type: "thinking", thinking: "first" }] },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["first"],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: { ...baseMessage, content: [{ type: "thinking", thinking: "first second" }] },
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: " second",
        partial: {},
      },
    });
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["first second"],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: {
        ...baseMessage,
        content: [
          { type: "thinking", thinking: "first second" },
          { type: "text", text: "answer" },
        ],
      },
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer", partial: {} },
    });
    assert.deepEqual(
      runtimeTab.chat
        .filter((line) => line.role === "thinking" || line.role === "assistant")
        .map((line) => `${line.role}:${line.text}`),
      ["thinking:first second", "assistant:answer"],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: {
        ...baseMessage,
        content: [
          { type: "thinking", thinking: "final thinking" },
          { type: "text", text: "final answer" },
        ],
      },
    });
    assert.deepEqual(
      runtimeTab.chat
        .filter((line) => line.role === "thinking" || line.role === "assistant")
        .map((line) => `${line.role}:${line.text}`),
      ["thinking:final thinking", "assistant:final answer"],
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
