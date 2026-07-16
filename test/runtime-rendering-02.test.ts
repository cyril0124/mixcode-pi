import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  TUI,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type OverlayOptions,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
  MIXCODE_KEYMAP,
  describeScopedKeymap,
  describeKeymap,
  handleSubmittedInput,
  mixcodeFauxStream,
  padLine,
  renderChat,
  renderCommandPalette,
  renderConfig,
  renderSystemToolsText,
  renderExtensionFooter,
  renderExtensionHeader,
  renderExtensionWidgets,
  renderHeader,
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderSidebar,
  renderStatus,
  renderTabBar,
  renderTabJumpOverlay,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
  titledBox,
  themeForId,
} from "../src/index.js";
import { observeRenderMarkdownForTests } from "../src/ui/rendering/markdown.js";

function delayedAssistantStream(text: string, ready: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message = runtimeAssistantMessage(`Echo: ${text}`);
    await ready;
    if (options?.signal?.aborted) {
      const aborted = {
        ...message,
        content: [],
        stopReason: "aborted" as const,
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...message, content: [{ type: "text", text: "" }] },
    });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: message.content[0]!.text,
      partial: message,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: message.content[0]!.text,
      partial: message,
    });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function runtimeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "queue-test",
    provider: "queue-test",
    model: "queue-test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function lastRuntimeUserText(context: Context): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("\n");
  }
  return "";
}

async function waitForRuntime(predicate: () => boolean, attempts = 25): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

async function waitFor(predicate: () => boolean, attempts = 25): Promise<void> {
  await waitForRuntime(predicate, attempts);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("rendering exposes chat, tool, extension, and agent surface landmarks", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    pendingDialogs: [
      {
        requestId: "q",
        sessionId: "s1",
        questions: [],
        currentQuestionIndex: 0,
        highlightedOptionIndices: [],
        selectedAnswers: [],
        customAnswers: [],
        dirty: false,
      },
    ],
    unreadDone: true,
    pendingMessages: ["queued extension work"],
    extensionUi: {
      statuses: [{ key: "extension", text: "ready" }],
      widgets: [],
      toolsExpanded: true,
      workingVisible: true,
    },
  });
  state.tabs.push(tab);
  const many = Array.from({ length: 16 }, (_, index) => ({
    role: "user" as const,
    text: `line-${index}`,
  }));
  const mixed = [
    { role: "assistant" as const, text: "agent\nreply" },
    { role: "tool" as const, text: "tool output" },
    { role: "system" as const, text: "system notice" },
  ];
  assert.equal(
    stripAnsi(renderInputMeta({ ...tab, currentContextTokens: 10 }, 80).join("\n")).includes(
      "0.01k/200k (0%)",
    ),
    true,
  );
  assert.match(
    renderInputMeta({ ...tab, currentContextTokens: 49_000, contextLimit: 100_000 }, 80).join("\n"),
    /\x1b\[38;2;181;189;104m49k\/100k \(49%\)/,
  );
  assert.match(
    renderInputMeta({ ...tab, currentContextTokens: 50_000, contextLimit: 100_000 }, 80).join("\n"),
    /\x1b\[38;2;138;190;183m50k\/100k \(50%\)/,
  );
  assert.match(
    renderInputMeta({ ...tab, currentContextTokens: 80_000, contextLimit: 100_000 }, 80).join("\n"),
    /\x1b\[38;2;212;106;106m80k\/100k \(80%\)/,
  );
  assert.match(renderChat(many, 80).join("\n"), /line-0[\s\S]*line-15/);
  const userChat = stripAnsi(renderChat([{ role: "user", text: "hello" }], 40).join("\n"));
  assert.deepEqual(
    userChat.split("\n").map((line) => line.trimEnd()),
    ["", " hello", ""],
  );
  assert.doesNotMatch(userChat, /\buser\b/);
  assert.equal(renderChat([{ role: "user", text: "hello" }], 40).length, 3);
  const multilineUserChat = stripAnsi(
    renderChat([{ role: "user", text: "h\ne\nl\nl\no" }], 40).join("\n"),
  )
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  assert.deepEqual(multilineUserChat.split("\n"), ["", " h", " e", " l", " l", " o", ""]);
  assert.equal(multilineUserChat.includes("›"), false);
  assert.match(renderChat(mixed, 80).join("\n"), /agent/);
  assert.match(renderChat(mixed, 80).join("\n"), /tool/);
  assert.match(renderChat(mixed, 80).join("\n"), /system notice/);
  assert.doesNotMatch(renderChat(mixed, 80).join("\n"), /\[System\]:/);
  assert.equal(renderChat([{ role: "thinking", text: "" }], 80).join("\n"), "");
  const toolDefaults = renderChat(
    [
      { role: "tool", text: "" },
      { role: "tool", status: "error", text: "bad" },
    ],
    80,
  ).join("\n");
  assert.match(toolDefaults, /tool/);
  assert.doesNotMatch(toolDefaults, /tool call/);
  assert.doesNotMatch(toolDefaults, /success/);
  assert.match(toolDefaults, /bad/);
  const userBashOutput = Array.from({ length: 25 }, (_, index) => `bash-line-${index}`).join("\n");
  const userBashCollapsed = stripAnsi(
    renderChat(
      [
        {
          role: "tool",
          title: "bash",
          variant: "user-bash",
          status: "success",
          text: userBashOutput,
          args: { command: "printf lines" },
        },
      ],
      80,
    ).join("\n"),
  );
  assert.match(userBashCollapsed, /^─+$/m);
  assert.match(userBashCollapsed, /\$ printf lines/);
  assert.doesNotMatch(userBashCollapsed, /bash-line-4\b/);
  assert.match(userBashCollapsed, /bash-line-5[\s\S]*bash-line-24/);
  assert.match(userBashCollapsed, /5 more lines/);
  const userBashTruncated = stripAnsi(
    renderChat(
      [
        {
          role: "tool",
          title: "bash",
          variant: "user-bash",
          status: "success",
          text: userBashOutput,
          args: { command: "printf lines" },
          bashTruncated: true,
          bashFullOutputPath: "/tmp/full.log",
        },
      ],
      80,
    ).join("\n"),
  );
  assert.match(
    userBashTruncated,
    /5 more lines \(ctrl\+o to expand\)[\s\S]*Output truncated\. Full output: \/tmp\/full\.log/,
  );
  const userBashExpanded = stripAnsi(
    renderChat(
      [
        {
          role: "tool",
          title: "bash",
          variant: "user-bash",
          status: "success",
          text: userBashOutput,
          args: { command: "printf lines" },
        },
      ],
      80,
      undefined,
      { ...tab, extensionUi: { ...tab.extensionUi, toolsExpanded: true } },
    ).join("\n"),
  );
  assert.match(userBashExpanded, /bash-line-0[\s\S]*bash-line-24/);
  const piBlocks = renderChat(
    [
      { role: "thinking", text: "checking context" },
      {
        role: "tool",
        title: "read",
        status: "running",
        text: "",
        args: { path: "src/index.ts" },
      },
      {
        role: "tool",
        title: "read",
        status: "success",
        text: "ok 12 lines",
        args: { path: "src/index.ts" },
      },
      { role: "tool", title: "bash", status: "running", text: "", args: { command: "pwd" } },
      {
        role: "tool",
        title: "extension_questions",
        status: "success",
        text: "Questions queued",
        args: { requestId: "r1", questions: [{ header: "H" }] },
      },
      { role: "tool", title: "todo_write", status: "success", text: "", args: { todos: [] } },
    ],
    80,
  ).join("\n");
  assert.match(piBlocks, /checking context/);
  assert.match(piBlocks, /read src\/index\.ts/);
  assert.match(piBlocks, /ok 12 lines/);
  assert.match(piBlocks, /\$ pwd/);
  assert.match(piBlocks, /extension_questions/);
  assert.match(piBlocks, /requestId/);
  assert.match(piBlocks, /todo_write/);
  assert.doesNotMatch(piBlocks, /tool call read/);
  assert.doesNotMatch(piBlocks, /running/);
  assert.doesNotMatch(piBlocks, /success/);
  const controlBlocks = renderChat(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        text: "\x1b]9;notify\x07osc\n\x1bPpayload\x1b\\dcs\n\x1bXpm\x1b\\pm\n\x1b^privacy\x1b\\privacy\n\x1b_apc\x1b\\apc\n\x1b?literal",
        args: { command: "printf controls" },
      },
    ],
    80,
  ).join("\n");
  assert.match(
    stripAnsi(controlBlocks),
    /osc[\s\S]*dcs[\s\S]*pm[\s\S]*privacy[\s\S]*apc[\s\S]*literal/,
  );
  assert.doesNotMatch(controlBlocks, /\x1b]9;notify\x07/);
  assert.doesNotMatch(controlBlocks, /\x1bPpayload\x1b\\/);
  assert.doesNotMatch(controlBlocks, /\x1bXpm\x1b\\/);
  assert.doesNotMatch(controlBlocks, /\x1b\^privacy\x1b\\/);
  assert.doesNotMatch(controlBlocks, /\x1b_apc\x1b\\/);
  const extensionBlocks = renderChat(
    [
      { role: "extension", title: "extension note", customType: "note", text: "fallback text" },
      {
        role: "extension",
        title: "extension rendered",
        customType: "rendered",
        text: "raw text",
        renderExtension: () => ["rendered extension text"],
      },
      {
        role: "extension",
        title: "extension empty-render",
        customType: "empty-render",
        text: "fallback after empty render",
        renderExtension: () => [],
      },
    ],
    80,
  ).join("\n");
  assert.match(extensionBlocks, /extension note/);
  assert.match(extensionBlocks, /fallback text/);
  assert.match(extensionBlocks, /rendered extension text/);
  assert.match(extensionBlocks, /fallback after empty render/);
  assert.equal(renderChat([{ role: "assistant", text: "" }], 80).join("\n"), "");
  assert.equal(renderChat([{ role: "user", text: "" }], 80).join("\n"), "");
  const assistantZone = renderChat([{ role: "assistant", text: "zoned assistant" }], 80);
  assert.ok(assistantZone[0]?.startsWith("\x1b]133;A\x07"));
  assert.ok(assistantZone.at(-1)?.includes("\x1b]133;B\x07\x1b]133;C\x07"));
  const userZone = renderChat([{ role: "user", text: "zoned user" }], 80);
  assert.ok(userZone[0]?.startsWith("\x1b]133;A\x07"));
  assert.ok(userZone.at(-1)?.includes("\x1b]133;B\x07\x1b]133;C\x07"));
  const markdownRendered = renderChat(
    [
      {
        role: "assistant",
        text: [
          "# Title",
          "",
          "Use **bold** and `code`.",
          "",
          "- first item",
          "- second item",
          "",
          "```ts",
          "const value = 1;",
          "```",
        ].join("\n"),
      },
    ],
    40,
  );
  const markdownPlain = stripAnsi(markdownRendered.join("\n"));
  assert.match(markdownPlain, / Title/);
  assert.match(markdownPlain, /Use bold and code\./);
  assert.match(markdownPlain, /- first item/);
  assert.match(markdownPlain, /```ts[\s\S]*const value = 1;[\s\S]*```/);
  assert.doesNotMatch(markdownPlain, /\*\*bold\*\*/);
  assert.doesNotMatch(markdownPlain, /`code`/);
  assert.equal(
    markdownRendered.every((line) => visibleWidth(line) <= 40),
    true,
  );
});

test("chat rendering reuses stable assistant markdown while streaming text changes", () => {
  const stable = { role: "assistant" as const, text: "stable **history**" };
  const streaming = { role: "assistant" as const, text: "partial one" };
  const observed: string[] = [];
  observeRenderMarkdownForTests((text) => observed.push(text));
  try {
    renderChat([stable, streaming], 80);
    streaming.text = "partial two";
    renderChat([stable, streaming], 80);
  } finally {
    observeRenderMarkdownForTests(undefined);
  }
  assert.deepEqual(observed, ["stable **history**", "partial one", "partial two"]);
});

test("runtime renders Pi edit tool diffs through the built-in renderer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-edit-render-"));
  try {
    await writeFile(join(dir, "run.sh"), "echo old\n", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const editTool = runtimeTab.agent.state.tools.find((tool) => tool.name === "edit");
    assert.ok(editTool);
    const args = {
      path: "run.sh",
      edits: [{ oldText: "echo old", newText: "echo new" }],
    };
    const result = await editTool.execute("tc-edit", args);
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "tc-edit",
      toolName: "edit",
      args,
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "tc-edit",
      toolName: "edit",
      result,
      isError: false,
    });

    const rendered = renderChat(runtimeTab.chat, 100).join("\n");
    const renderedLines = stripAnsi(rendered).split("\n");
    const plain = stripAnsi(rendered);
    const editLineIndex = renderedLines.findIndex((line) => /edit run\.sh/.test(line));
    assert.notEqual(editLineIndex, -1);
    assert.doesNotMatch(renderedLines[editLineIndex] ?? "", /\x1b\[48;2;38;38;36m/);
    assert.match(plain, /edit run\.sh/);
    assert.match(plain, /▌.*1.*│.*echo old/);
    assert.match(plain, /▌.*1.*│.*echo new/);
    assert.doesNotMatch(plain, /Successfully replaced/);
    assert.match(rendered, /\x1b\[[0-?]*m/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
