import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  CURSOR_MARKER,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type OverlayOptions,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  type MixCodeRuntime,
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

test("createMixCodeTui submit hook persists prompt history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-tui-history-"));
  try {
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo");
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const prompts: string[] = [];
    const runtime = {
      onChange: () => () => undefined,
      getTab: () => ({ tab, chat: [] }),
      prompt: async (_sessionId: string, text: string) => {
        prompts.push(text);
      },
      appendSystemMessage: () => undefined,
      getExtensionCommands: () => [],
      getAllExtensionCommands: () => [],
      applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
      setExtensionUiHost: () => undefined,
    } as unknown as MixCodeRuntime;
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal(), rootStateDir: dir });
    try {
      const layout = (
        tui as unknown as {
          children: Array<{
            editor: { setText: (text: string) => void; submitCurrentText: () => void };
          }>;
        }
      ).children[0]!;
      layout.editor.setText("hello tui-history  ");
      layout.editor.submitCurrentText();
      await waitForRuntime(() => prompts.length === 1);
      const historyFile = join(dir, "history.jsonl");
      for (let i = 0; i < 25; i += 1) {
        if (/hello tui-history/.test(await readFile(historyFile, "utf8").catch(() => ""))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(prompts, ["hello tui-history"]);
      assert.match(await readFile(historyFile, "utf8"), /"text":"hello tui-history"/);
    } finally {
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createMixCodeTui editor slot handles input, autocomplete host, and submit", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  const backgroundTab = createTab(2, "background", "/repo");
  state.tabs.push(tab, backgroundTab);
  state.activeTabId = "s1";
  const prompts: string[] = [];
  const chat: Array<{
    role: "user" | "assistant" | "thinking" | "tool" | "system" | "extension";
    text: string;
  }> = [];
  const runtime = {
    onChange: () => () => undefined,
    getTab: (sessionId: string) => (sessionId === "s1" ? { tab, chat } : undefined),
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
    appendSystemMessage: (_sessionId: string, text: string) => {
      chat.push({ role: "system", text });
      tab.previewMessages.push({ role: "system", text });
      tab.previewIndex = tab.previewMessages.length - 1;
    },
    clearTab: async () => {
      throw new Error("clear failed");
    },
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => ({
      getSuggestions: async (lines, cursorLine, cursorCol, options) => {
        if ((lines[cursorLine] ?? "").startsWith("#")) {
          return {
            prefix: "#",
            items: [
              { value: "#extension", label: "extension" },
              { value: "#extra", label: "extra" },
            ],
          };
        }
        return base.getSuggestions(lines, cursorLine, cursorCol, options);
      },
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
        base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: () => true,
    }),
  } as unknown as MixCodeRuntime;
  const terminal = silentTerminal();
  const tui = createMixCodeTui(state, runtime, {
    terminal,
    completionSources: { skills: ["review", "refactor"], files: ["src/index.ts"] },
  });
  try {
    const submitOverlays: string[] = [];
    const originalShowOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
      submitOverlays.push(component.render?.(80).join("\n") ?? String(component));
      return originalShowOverlay(component, options);
    }) as typeof tui.showOverlay;
    const layout = (
      tui as unknown as {
        children: Array<{
          editor: {
            current: Component & { getAutocompleteMaxVisible?: () => number };
            getText: () => string;
            setText: (text: string) => void;
            insertTextAtCursor: (text: string) => void;
            addToHistory: (text: string) => void;
            isShowingAutocomplete: () => boolean;
            handleInput: (data: string) => void;
            setAutocompleteProvider: (provider: AutocompleteProvider) => void;
            setEditorComponent: (factory: unknown) => void;
            getEditorComponent: () => unknown;
            submitCurrentText: () => void;
            onChange?: (text: string) => void;
          };
        }>;
      }
    ).children[0]!;
    layout.invalidate();
    assert.ok(layout.editor.current);
    layout.editor.handleInput("h");
    assert.equal(layout.editor.getText(), "h");
    layout.editor.insertTextAtCursor("i");
    assert.equal(layout.editor.getText(), "hi");
    layout.editor.setText("");
    layout.editor.handleInput("@");
    await waitFor(() => layout.editor.isShowingAutocomplete());
    assert.equal(layout.editor.current.getAutocompleteMaxVisible?.(), 8);
    assert.match(stripAnsi(layout.editor.current.render(80).join("\n")), /src\/index\.ts/);
    layout.editor.handleInput("\u007f");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(layout.editor.isShowingAutocomplete(), false);
    assert.equal(layout.editor.getText(), "");
    layout.editor.addToHistory("older");
    layout.editor.setText("");
    layout.editor.handleInput("\x1b[A");
    assert.equal(layout.editor.getText(), "older");
    layout.editor.handleInput("\x1b[B");
    assert.equal(layout.editor.getText(), "");
    const changed: string[] = [];
    layout.editor.onChange = (text) => changed.push(text);
    const submitted: string[] = [];
    const customHistory: string[] = [];
    let customText = "custom-text";
    let customSubmit: ((text: string) => void) | undefined;
    const customEditor = {
      render: () => ["custom"],
      invalidate: () => undefined,
      handleInput: () => undefined,
      getText: () => customText,
      setText: (text: string) => {
        customText = text;
      },
      borderColor: "custom-border",
      addToHistory: (text: string) => customHistory.push(text),
      set onSubmit(handler: ((text: string) => void) | undefined) {
        customSubmit = handler;
        if (handler) submitted.push("handler-set");
      },
      set onChange(handler: ((text: string) => void) | undefined) {
        handler?.("custom-change");
      },
      setPaddingX: (value: number) => {
        submitted.push(`padding:${value}`);
      },
      setAutocompleteProvider: (_provider: AutocompleteProvider) => {
        submitted.push("autocomplete-set");
      },
    };
    layout.editor.setEditorComponent(() => customEditor);
    assert.equal(typeof layout.editor.getEditorComponent(), "function");
    assert.equal(typeof customEditor.borderColor, "function");
    layout.editor.addToHistory("custom-history");
    layout.editor.insertTextAtCursor("+");
    layout.editor.submitCurrentText();
    customSubmit?.("custom-text");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(customHistory, ["custom-history", "custom-text"]);
    assert.deepEqual(prompts, ["custom-text"]);
    assert.deepEqual(submitted, ["handler-set", "padding:1", "autocomplete-set"]);
    layout.editor.setText("restore-text");
    layout.editor.setEditorComponent(undefined);
    assert.equal(layout.editor.getEditorComponent(), undefined);
    assert.equal(layout.editor.getText(), "restore-text");
    assert.deepEqual(changed, ["custom-change", "restore-text"]);
    layout.editor.setText("inactive-draft", "background");
    assert.equal(layout.editor.getText("background"), "inactive-draft");
    layout.editor.pasteToEditor("+paste", "background");
    assert.equal(layout.editor.getExpandedText("background"), "inactive-draft+paste");
    let fallbackText = "fallback";
    layout.editor.setEditorComponent(() => ({
      render: () => ["fallback-editor"],
      invalidate: () => undefined,
      handleInput: () => undefined,
      getText: () => fallbackText,
      setText: (text: string) => {
        fallbackText = text;
      },
    }));
    layout.editor.insertTextAtCursor("+");
    assert.equal(fallbackText, "restore-text+");
    layout.editor.setEditorComponent(undefined);
    let inactiveReplacementText = "inactive";
    const inactiveAutocomplete: string[] = [];
    layout.editor.setEditorComponent(
      () => ({
        render: () => ["inactive-editor"],
        invalidate: () => undefined,
        handleInput: (data: string) => {
          inactiveReplacementText += data;
        },
        getText: () => inactiveReplacementText,
        getExpandedText: () => `${inactiveReplacementText}:expanded`,
        setText: (text: string) => {
          inactiveReplacementText = text;
        },
        setAutocompleteProvider: () => inactiveAutocomplete.push("set"),
      }),
      "background",
    );
    assert.equal(typeof layout.editor.getEditorComponent("background"), "function");
    layout.editor.setText("inactive-custom", "background");
    layout.editor.pasteToEditor("!", "background");
    assert.equal(layout.editor.getText("background"), "inactive-custom\u001b[200~!\u001b[201~");
    assert.equal(
      layout.editor.getExpandedText("background"),
      "inactive-custom\u001b[200~!\u001b[201~:expanded",
    );
    layout.editor.setAutocompleteProvider({
      getSuggestions: async (lines, cursorLine) => {
        const line = lines[cursorLine] ?? "";
        if (line.startsWith("#")) {
          return {
            prefix: "#",
            items: [
              { value: "#extension", label: "extension" },
              { value: "#extra", label: "extra" },
            ],
          };
        }
        if (line.startsWith("$")) {
          return {
            prefix: line,
            items: [{ value: "$review", label: "review" }],
          };
        }
        return null;
      },
      applyCompletion: (_lines, cursorLine, _cursorCol, item: AutocompleteItem) => ({
        lines: [item.value],
        cursorLine,
        cursorCol: item.value.length,
      }),
      shouldTriggerFileCompletion: () => true,
    });
    assert.deepEqual(inactiveAutocomplete, ["set", "set"]);
    layout.editor.setEditorComponent(undefined, "background");
    assert.equal(layout.editor.getEditorComponent("background"), undefined);
    assert.equal(
      layout.editor.getText("background"),
      "inactive-custom\u001b[200~!\u001b[201~:expanded",
    );
    const propagatedHandlers: string[] = [];
    layout.editor.setEditorComponent(
      () => ({
        render: () => [],
        invalidate: () => undefined,
        handleInput: () => undefined,
        getText: () => "",
        setText: () => undefined,
        set onChange(handler: ((text: string) => void) | undefined) {
          if (handler) propagatedHandlers.push("change");
        },
      }),
      "background",
    );
    layout.editor.onChange = (text) => changed.push(text);
    assert.deepEqual(propagatedHandlers.slice(-1), ["change"]);
    layout.editor.setEditorComponent(undefined, "background");
    layout.editor.setText("#");
    layout.editor.handleInput("\t");
    await waitFor(() => layout.editor.isShowingAutocomplete());
    assert.equal(layout.editor.isShowingAutocomplete(), true);
    layout.editor.handleInput("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(layout.editor.getText(), "#extension");
    layout.editor.handleInput("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(prompts, ["custom-text", "#extension"]);
    assert.equal(layout.editor.getText(), "");

    layout.editor.setText("");
    layout.editor.handleInput("$");
    await waitFor(() => layout.editor.isShowingAutocomplete());
    layout.editor.handleInput("\u007f");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(layout.editor.isShowingAutocomplete(), false);
    assert.equal(layout.editor.getText(), "");
    layout.editor.handleInput("$");
    await waitFor(() => layout.editor.isShowingAutocomplete());
    layout.editor.handleInput("r");
    await waitFor(() => layout.editor.isShowingAutocomplete());
    layout.editor.handleInput("\t");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(layout.editor.getText(), "$review");
    layout.editor.setText("");
    layout.editor.setText("/theme");
    layout.editor.handleInput("\r");
    await waitFor(() => state.picker?.kind === "theme");
    assert.equal(layout.editor.getText(), "");
    assert.match(renderPickerOverlay(state, 80).join("\n"), /Choose Theme/);
    state.picker = undefined;

    layout.editor.setText("/clear");
    layout.editor.handleInput("\r");
    await waitFor(() => chat.some((message) => message.text === "Clear failed: clear failed"));
    assert.equal(
      submitOverlays.some((overlay) => /clear failed/.test(overlay)),
      false,
    );
    assert.equal(layout.editor.getText(), "");

    layout.editor.setText("/does-not-exist");
    layout.editor.handleInput("\r");
    await waitFor(() =>
      chat.some((message) => message.text === "Unknown slash command: /does-not-exist"),
    );
    assert.equal(
      submitOverlays.some((overlay) => /Unknown slash command: \/does-not-exist/.test(overlay)),
      false,
    );
    (tui as unknown as { handleInput: (data: string) => void }).handleInput("\x1b");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (tui as unknown as { focusedComponent?: unknown }).focusedComponent,
      layout.editor,
    );
    (tui as unknown as { handleInput: (data: string) => void }).handleInput("a");
    assert.equal(layout.editor.getText(), "a");
    layout.editor.setText("");

    const submitPropagation: string[] = [];
    layout.editor.setEditorComponent(
      () => ({
        render: () => [],
        invalidate: () => undefined,
        handleInput: () => undefined,
        getText: () => "",
        setText: () => undefined,
        set onSubmit(handler: ((text: string) => void) | undefined) {
          if (handler) submitPropagation.push("submit");
        },
      }),
      "background",
    );
    layout.editor.onSubmit = (text) => prompts.push(text);
    assert.deepEqual(submitPropagation, ["submit", "submit"]);
    layout.editor.setEditorComponent(undefined, "background");

    state.activeTabId = "config";
    (tui as unknown as { handleInput: (data: string) => void }).handleInput("x");
    // Agent View now accepts editor input for sending messages to selected agent.
    assert.equal(layout.editor.getText(), "x");
    layout.editor.setText("");
    assert.deepEqual(
      await runtime
        .applyExtensionAutocompleteProviders(
          "s1",
          new MixCodeCompletionProvider({ skills: [], files: [] }),
        )
        .getSuggestions(["#"], 0, 1, { signal: new AbortController().signal }),
      {
        prefix: "#",
        items: [
          { value: "#extension", label: "extension" },
          { value: "#extra", label: "extra" },
        ],
      },
    );
    state.tabs.length = 0;
    const configCommands = await new MixCodeCompletionProvider({
      skills: [],
      files: [],
      commands: () => runtime.getAllExtensionCommands(),
    }).getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.equal(configCommands.prefix, "/");
    assert.equal(
      configCommands.items.some((item) => item.value === "/help"),
      true,
    );

    const externalDir = await mkdtemp(join(tmpdir(), "mixcode-external-editor-ok-"));
    let externalCapture = "";
    const editorScript = join(externalDir, "editor.sh");
    const previousEditor = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    await writeFile(editorScript, `#!/bin/sh\nprintf changed > "$1"\n`, { mode: 0o755 });
    const externalState = createInitialState("/repo");
    const externalTab = createTab(2, "s2", "/repo");
    externalState.tabs.push(externalTab);
    externalState.activeTabId = "s2";
    const externalRuntime = {
      onChange: () => () => undefined,
      getTab: (sessionId: string) =>
        sessionId === "s2" ? { tab: externalTab, chat: [] } : undefined,
      prompt: async () => undefined,
      getExtensionCommands: () => [],
      getAllExtensionCommands: () => [],
      setExtensionUiHost: () => undefined,
      applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
    } as unknown as MixCodeRuntime;
    const externalTui = createMixCodeTui(externalState, externalRuntime, {
      terminal: {
        ...silentTerminal(),
        start: () => {
          externalCapture += "start;";
        },
        stop: () => {
          externalCapture += "stop;";
        },
      },
      externalEditor: editorScript,
    });
    try {
      const externalLayout = (
        externalTui as unknown as {
          children: Array<{ editor: { setText: (text: string) => void; getText: () => string } }>;
          handleInput: (data: string) => void;
        }
      ).children[0]!;
      externalLayout.editor.setText("initial");
      (externalTui as unknown as { handleInput: (data: string) => void }).handleInput("\x05");
      await waitFor(() => externalLayout.editor.getText() === "changed");
      assert.equal(externalCapture, "stop;start;");
      process.env.EDITOR = editorScript;
      delete process.env.VISUAL;
      await handleSubmittedInput(
        externalState,
        {
          ...externalRuntime,
          getTab: (sessionId: string) =>
            sessionId === "s2"
              ? {
                  tab: externalTab,
                  chat: [],
                  agent: { state: { systemPrompt: "system prompt" } },
                }
              : undefined,
        } as unknown as MixCodeRuntime,
        "/system-prompt",
        externalTui,
      );
      assert.equal(
        (externalTui as unknown as { focusedComponent?: unknown }).focusedComponent,
        externalLayout.editor,
      );
      (externalTui as unknown as { handleInput: (data: string) => void }).handleInput("x");
      assert.equal(externalLayout.editor.getText(), "changedx");
    } finally {
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
      externalTui.stop();
      await rm(externalDir, { recursive: true, force: true });
    }

    const failureDir = await mkdtemp(join(tmpdir(), "mixcode-external-editor-fail-"));
    const failureScript = join(failureDir, "editor.sh");
    await writeFile(failureScript, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const failureState = createInitialState("/repo");
    const failureTab = createTab(3, "s3", "/repo");
    failureState.tabs.push(failureTab);
    failureState.activeTabId = "s3";
    const failureTui = createMixCodeTui(failureState, externalRuntime, {
      terminal: silentTerminal(),
      externalEditor: failureScript,
    });
    const failureOverlays: string[] = [];
    const originalFailureShowOverlay = failureTui.showOverlay.bind(failureTui);
    failureTui.showOverlay = ((component: Component, options?: OverlayOptions) => {
      failureOverlays.push(component.render?.(80).join("\n") ?? String(component));
      return originalFailureShowOverlay(component, options);
    }) as typeof failureTui.showOverlay;
    try {
      (failureTui as unknown as { handleInput: (data: string) => void }).handleInput("\x05");
      await waitFor(() =>
        failureOverlays.some((overlay) => /External editor exited with 7/.test(overlay)),
      );
    } finally {
      failureTui.stop();
      await rm(failureDir, { recursive: true, force: true });
    }
  } finally {
    tui.stop();
  }
});

test("createMixCodeTui editor slot renders the input cursor while focused", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat: Array<{ role: "user" | "assistant" | "thinking" | "tool" | "system"; text: string }> =
    [];
  const runtime = {
    onChange: () => () => undefined,
    getTab: () => ({ tab, chat }),
    prompt: async () => undefined,
    appendSystemMessage: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  const layout = (
    tui as unknown as {
      children: Array<{
        editor: {
          current: Component & { focused?: boolean };
          handleInput: (data: string) => void;
          render: (width: number) => string[];
        };
      }>;
    }
  ).children[0]!;

  assert.equal((tui as unknown as { focusedComponent?: unknown }).focusedComponent, layout.editor);
  assert.equal(layout.editor.current.focused, true);

  const emptySurface = layout.editor.render(80).join("\n");
  assert.equal(emptySurface.includes(CURSOR_MARKER), true);
  assert.match(emptySurface, /\x1b\[7m \x1b\[0m/);
  assert.match(stripAnsi(emptySurface), /Send message to Agent-01/);
  // Top border carries the agent title at the right end; bottom stays plain.
  assert.match(stripAnsi(emptySurface).split("\n")[0]!, /^─+ Agent-01 ──$/);
  assert.equal(visibleWidth(stripAnsi(emptySurface).split("\n")[0]!), 80);
  assert.equal(stripAnsi(emptySurface).split("\n").at(-1), "─".repeat(80));
  assert.doesNotMatch(stripAnsi(emptySurface), /^\s*> /m);
  assert.match(emptySurface, /\x1b\[38;2;217;119;87m─/);

  layout.editor.handleInput("a");
  const textSurface = layout.editor.render(80).join("\n");
  assert.equal(textSurface.includes(CURSOR_MARKER), true);
  assert.match(textSurface, /a\x1b_pi:c\x07\x1b\[7m \x1b\[0m/);

  layout.editor.setText("x".repeat(120));
  const wrappedSurface = stripAnsi(layout.editor.render(40).join("\n"));
  assert.doesNotMatch(wrappedSurface, /\.\.\./);
  assert.match(wrappedSurface, /xxx\s*$/m);
  assert.equal(
    wrappedSurface.split("\n").every((line) => visibleWidth(line) <= 40),
    true,
  );

  layout.editor.setText("!pwd");
  const shellSurface = layout.editor.render(80).join("\n");
  assert.equal(shellSurface.includes(CURSOR_MARKER), true);
  assert.match(shellSurface, /\x1b\[38;2;220;236;244m─/);

  layout.editor.setText("");
  tab.vimMode = true;
  const vimSurface = layout.editor.render(80).join("\n");
  assert.equal(vimSurface.includes(CURSOR_MARKER), false);
  assert.match(stripAnsi(vimSurface), /^ Vim mode · q to exit/m);
  assert.doesNotMatch(stripAnsi(vimSurface), /Send message to Agent-01/);
  // Top border gains a [VIM] badge near the left and keeps the title at right.
  assert.match(stripAnsi(vimSurface).split("\n")[0]!, /^── \[VIM\] ─+ Agent-01 ──$/);
  assert.equal(visibleWidth(stripAnsi(vimSurface).split("\n")[0]!), 80);
  assert.equal(stripAnsi(vimSurface).split("\n").at(-1), "─".repeat(80));
  // Dashes are vim-border colored.
  assert.match(vimSurface, /\x1b\[38;2;201;164;255m─/);
  // Title follows vim border color in vim mode.
  assert.match(vimSurface, /\x1b\[38;2;201;164;255mAgent-01/);
  layout.editor.setText("draft");
  layout.editor.handleInput("x");
  assert.equal(layout.editor.current.getText(), "draft");
});
