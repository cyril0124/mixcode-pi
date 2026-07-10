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
  AuthStorage,
  getMarkdownTheme,
  ModelRegistry,
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
  handleMixCodeKeyInput,
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
  UUIDV7_SESSION_ID_PATTERN,
} from "../src/index.js";
import { hydrateTabPromptHistory } from "../src/ui/app-runtime.js";

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

test("createMixCodeTui hydrates editor history per tab from restored runtime user messages", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  const tab2 = createTab(2, "s2", "/repo");
  state.tabs.push(tab, tab2);
  state.activeTabId = "s1";
  const historyReady = new Set<string>();
  let extensionConsumesUp = true;
  const runtime = {
    onChange: () => () => undefined,
    getTab: (sessionId: string) =>
      historyReady.has(sessionId)
        ? {
            tab: sessionId === "s1" ? tab : tab2,
            chat: [],
          }
        : undefined,
    getPromptHistory: (sessionId: string) => {
      if (!historyReady.has(sessionId)) return [];
      return sessionId === "s1" ? ["older prompt", "newer prompt"] : ["tab two prompt"];
    },
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
    dispatchTerminalInput: (_sessionId: string, data: string) =>
      extensionConsumesUp && data === "\x1b[A" ? { consume: true } : undefined,
    setExtensionUiHost: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  try {
    const layout = (
      tui as unknown as {
        children: Array<{ editor: { getText: () => string; handleInput: (data: string) => void } }>;
      }
    ).children[0]!;
    const handleTuiInput = (data: string) =>
      (tui as unknown as { handleInput: (data: string) => void }).handleInput(data);
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "");
    historyReady.add("s1");
    historyReady.add("s2");
    hydrateTabPromptHistory(state, runtime);
    hydrateTabPromptHistory(state, runtime);
    assert.deepEqual(tab.promptHistory, ["newer prompt", "older prompt"]);
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "");
    extensionConsumesUp = false;
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "newer prompt");
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "older prompt");
    handleTuiInput("\x1b[B");
    assert.equal(layout.editor.getText(), "newer prompt");
    handleTuiInput("\x1b[B");
    assert.equal(layout.editor.getText(), "");
    handleTuiInput("\t");
    assert.equal(state.activeTabId, "s2");
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "tab two prompt");
    handleTuiInput("\x1b[Z");
    assert.equal(state.activeTabId, "s1");
    assert.equal(layout.editor.getText(), "");
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "newer prompt");
  } finally {
    tui.stop();
  }
});

test("submitted input handles prompt, shell, local commands, clear, and missing active tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-submit-"));
  const state = createInitialState(dir);
  const tab = createTab(1, "s1", dir);
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const prompts: string[] = [];
  const shellCommands: Array<{ command: string; excludeFromContext: boolean | undefined }> = [];
  const cleared: string[] = [];
  const closed: string[] = [];
  const created: string[] = [];
  const forked: string[] = [];
  const runtime = {
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
    executeShellCommand: async (
      _sessionId: string,
      command: string,
      options?: { excludeFromContext?: boolean },
    ) => {
      shellCommands.push({ command, excludeFromContext: options?.excludeFromContext });
    },
    appendSystemMessage: (_sessionId: string, text: string) => {
      tab.previewMessages.push({ role: "system", text });
      tab.previewIndex = tab.previewMessages.length - 1;
    },
    getTab: () => ({ chat: [{ role: "user", text: "old" }] }),
    clearTab: async (sessionId: string) => {
      cleared.push(sessionId);
      tab.sessionId = "cleared";
      return { tab };
    },
    createTab: async (createdTab: { sessionId: string }) => {
      created.push(createdTab.sessionId);
    },
    forkSession: async (_sourceSessionId: string, newSessionId: string) => {
      forked.push(newSessionId);
    },
    closeTab: async (sessionId: string) => {
      closed.push(sessionId);
    },
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
    resolveModel: (provider: string, modelId: string) => ({
      ...MIXCODE_FAUX_MODEL,
      provider,
      id: modelId,
    }),
    updateTabModel: (_sessionId: string, model: Model<any>) => {
      tab.model = {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      };
      tab.contextLimit = model.contextWindow;
    },
    getExtensionCommands: () => [{ name: "run", description: "Run extension command" }],
  } as unknown as MixCodeRuntime;
  const overlays: string[] = [];
  const tui = {
    requestRender: () => overlays.push("render"),
    showOverlay: (component: { render: (width: number) => string[] }) => {
      overlays.push(component.render(80).join("\n"));
      return {} as never;
    },
  };
  const changes: string[] = [];
  try {
    await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "description: review",
      "utf8",
    );
    await writeFile(join(dir, "AGENTS.md"), "Follow repo rules", "utf8");
    await handleSubmittedInput(state, runtime, "hello $review @src/index.ts", tui, (nextState) =>
      changes.push(nextState.activeTabId),
    );
    await handleSubmittedInput(state, runtime, "!pwd", tui);
    await handleSubmittedInput(state, runtime, "/clear", tui);
    // clearTab is deferred via setTimeout; wait for it to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handleSubmittedInput(state, runtime, "/thinking high", tui);
    await handleSubmittedInput(state, runtime, "/workdir /tmp/work", tui);
    await handleSubmittedInput(state, runtime, "/theme tokyo-night", tui);
    await handleSubmittedInput(state, runtime, "/models faux-1", tui);
    await handleSubmittedInput(state, runtime, "/rename Renamed", tui);
    await handleSubmittedInput(state, runtime, "/fork forked", tui);
    const forkedSessionId = state.activeTabId;
    assert.match(forkedSessionId, UUIDV7_SESSION_ID_PATTERN);
    assert.notEqual(forkedSessionId, "forked");
    await handleSubmittedInput(state, runtime, "/delete-session", tui);
    handleMixCodeKeyInput(state, "y", tui, undefined, runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handleSubmittedInput(state, runtime, "/new-session s2", tui);
    const newSessionId = state.activeTabId;
    assert.match(newSessionId, UUIDV7_SESSION_ID_PATTERN);
    assert.notEqual(newSessionId, "s2");
    await handleSubmittedInput(state, runtime, "/close-session", tui);
    handleMixCodeKeyInput(state, "y", tui, undefined, runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handleSubmittedInput(state, runtime, "/theme mixcode-dark", tui);
    await handleSubmittedInput(state, runtime, "/help", tui);
    await handleSubmittedInput(state, runtime, "/run worker task", tui);
    assert.equal(prompts[0], "hello $review @src/index.ts");
    assert.doesNotMatch(prompts[0] ?? "", /workdir-instructions|Follow repo rules/);
    assert.deepEqual(prompts.slice(1), ["/run worker task"]);
    assert.deepEqual(shellCommands, [{ command: "pwd", excludeFromContext: false }]);
    assert.deepEqual(cleared, ["s1"]);
    assert.deepEqual(closed, [newSessionId]);
    assert.deepEqual(created, [forkedSessionId, newSessionId]);
    assert.deepEqual(forked, [forkedSessionId]);
    assert.equal(state.activeTabId, "cleared");
    assert.equal(tab.previewMessages.some((message) => message.role === "shell"), false);
    assert.ok(changes.length > 0);
    assert.equal(tab.thinkingLevel, "high");
    assert.equal(tab.workdir, "/tmp/work");
    assert.equal(tab.title, "Renamed");
    assert.equal(tab.model.modelId, "faux-1");
    assert.equal(state.theme, "mixcode-dark");
    assert.ok(tab.previewMessages.some((msg: { text: string }) => msg.text.includes("Keyboard Shortcuts")));
    state.tabs.length = 0;
    await handleSubmittedInput(state, runtime, "ignored", tui);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted input rejects invalid thinking level", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  await assert.rejects(
    handleSubmittedInput(
      state,
      { getTab: () => undefined } as unknown as MixCodeRuntime,
      "/thinking impossible",
      {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      },
    ),
    /Unknown thinking level/,
  );
});

test("submitted input requires clear runtime replacement support", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  await assert.rejects(
    handleSubmittedInput(
      state,
      { getTab: () => undefined } as unknown as MixCodeRuntime,
      "/clear",
      {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      },
    ),
    /Clear requires runtime session replacement support/,
  );
});

test("submitted clear fires session replacement without blocking the caller", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let finishClear!: () => void;
  let clearStarted = false;
  const renderCalled: boolean[] = [];
  const runtime = {
    clearTab: async () => {
      clearStarted = true;
      await new Promise<void>((finish) => {
        finishClear = finish;
      });
      tab.sessionId = "cleared";
      return { tab };
    },
    getTab: () => ({ chat: [] }),
  } as unknown as MixCodeRuntime;
  await handleSubmittedInput(state, runtime, "/clear", {
    requestRender: () => {
      renderCalled.push(true);
    },
    showOverlay: () => ({}) as never,
  });
  // handleSubmittedInput returns immediately; clearTab is deferred via setTimeout.
  // Status is idle (no spinner) because clearTab blocks the event loop anyway.
  assert.ok(renderCalled.length > 0);
  assert.equal(tab.status, "idle");
  assert.equal(tab.workingStartedAt, undefined);
  assert.equal(clearStarted, false);
  // Let the setTimeout(32) fire and clearTab start.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clearStarted, true);
  // clearTab is still pending.
  assert.notEqual(state.activeTabId, "cleared");
  finishClear();
  // Let the .then() microtask run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.activeTabId, "cleared");
});

test("submitted clear resets tab state when replacement fails", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "done",
    workingStartedAt: "2026-05-10T00:00:00.000Z",
    lastWorkedDurationSeconds: 12,
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const systemMessages: string[] = [];
  await handleSubmittedInput(
    state,
    {
      clearTab: async () => {
        throw new Error("clear failed");
      },
      appendSystemMessage: (_sessionId: string, text: string) => {
        systemMessages.push(text);
      },
    } as unknown as MixCodeRuntime,
    "/clear",
    {
      requestRender: () => undefined,
      showOverlay: () => ({}) as never,
    },
  );
  // Let the setTimeout(32) fire and the .catch() run.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Status remains idle (set during clear); error is shown as system message.
  assert.equal(tab.status, "idle");
  assert.ok(systemMessages.some((msg) => msg.includes("clear failed")));
});

test("runtime enables Pi builtin tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-tools-"));
  try {
    await writeFile(join(dir, "a.txt"), "hello", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const tools = runtimeTab.agent.state.tools;
    const read = tools.find((tool) => tool.name === "read");
    const bash = tools.find((tool) => tool.name === "bash");
    const edit = tools.find((tool) => tool.name === "edit");
    const write = tools.find((tool) => tool.name === "write");
    assert.ok(read && bash && edit && write);
    assert.ok(tools.some((tool) => tool.name === "grep"));
    assert.ok(tools.some((tool) => tool.name === "find"));
    assert.ok(tools.some((tool) => tool.name === "ls"));
    assert.equal(
      tools.some((tool) => tool.name === "shell"),
      false,
    );
    assert.equal((await read.execute("1", { path: "a.txt" }, undefined)).content[0]?.type, "text");
    assert.match(
      (await bash.execute("2", { command: "printf ok" }, undefined)).content[0]?.text ?? "",
      /ok/,
    );
    const editResult = await edit.execute("3", {
      path: "a.txt",
      edits: [{ oldText: "hello", newText: "hello\nworld" }],
    });
    assert.match(editResult.content[0]?.text ?? "", /Successfully replaced/);
    assert.match(
      String(editResult.details && "diff" in editResult.details && editResult.details.diff),
      /\+2 world/,
    );
    await write.execute("4", { path: "b.txt", content: "created" }, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted bang command streams Pi bash locally instead of prompting the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bang-bash-"));
  try {
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const snapshots: string[] = [];
    runtime.onChange((_event, changedTab) => {
      snapshots.push(renderChat(changedTab.chat, 80).map(stripAnsi).join("\n"));
    });
    const tui = {
      requestRender: () => snapshots.push(renderChat(runtimeTab.chat, 80).map(stripAnsi).join("\n")),
      showOverlay: () => ({}) as never,
    };

    await handleSubmittedInput(
      state,
      runtime,
      "!sh -c 'printf shell-start; sleep 0.05; printf shell-end'",
      tui,
    );

    assert.equal(
      runtimeTab.chat.some((line) => line.role === "user" && line.text.includes("Run shell")),
      false,
    );
    assert.ok(snapshots.some((snapshot) => snapshot.includes("$ sh -c")));
    assert.ok(snapshots.some((snapshot) => snapshot.includes("shell-start")));
    assert.ok(
      runtimeTab.chat.some(
        (line) =>
          line.role === "tool" &&
          line.title === "bash" &&
          line.variant === "user-bash" &&
          !line.renderToolCall &&
          !line.renderToolResult &&
          line.args &&
          typeof line.args === "object" &&
          "command" in line.args &&
          line.args.command === "sh -c 'printf shell-start; sleep 0.05; printf shell-end'" &&
          line.status === "success" &&
          line.text.includes("shell-startshell-end"),
      ),
    );
    assert.ok(
      runtimeTab.session
        .getEntries()
        .some((entry) => entry.type === "message" && entry.message.role === "bashExecution"),
    );
    await handleSubmittedInput(state, runtime, "!!printf hidden-ok", tui);
    assert.ok(
      runtimeTab.session.getEntries().some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "bashExecution" &&
          entry.message.command === "printf hidden-ok" &&
          entry.message.excludeFromContext === true,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
