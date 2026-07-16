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

test("runtime initializes pi theme before rendering extension custom markdown overlays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-markdown-"));
  const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = (globalThis as Record<symbol, unknown>)[themeKey];
  delete (globalThis as Record<symbol, unknown>)[themeKey];
  const terminal = silentTerminal();
  const tui = new TUI(terminal);
  let overlayComponent: Component | undefined;
  const originalShowOverlay = tui.showOverlay.bind(tui);
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-markdown", {
      description: "Custom markdown overlay smoke",
      handler: async (_args, ctx) => {
        await ctx.ui.custom<string>(
          (_hostTui, _theme, _keybindings, done) => {
            const markdown = new Markdown("**ask_user** prompt", 0, 0, getMarkdownTheme());
            return {
              render: (width: number) => markdown.render(width),
              handleInput: () => done("ok"),
              invalidate: () => markdown.invalidate(),
            };
          },
          { overlay: true },
        );
      },
    });
  };

  tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
    overlayComponent = component;
    return originalShowOverlay(component, options);
  }) as typeof tui.showOverlay;

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost({ tui });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const task = runtime.prompt("s1", "/custom-markdown");
    await waitFor(() => !!overlayComponent);
    assert.match(stripAnsi(overlayComponent!.render(80).join("\n")), /ask_user prompt/);
    overlayComponent!.handleInput?.("\r");
    await task;
  } finally {
    if (previousTheme === undefined) delete (globalThis as Record<symbol, unknown>)[themeKey];
    else (globalThis as Record<symbol, unknown>)[themeKey] = previousTheme;
    tui.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps enter as the extension select confirmation key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-enter-"));
  const terminal = silentTerminal();
  const tui = new TUI(terminal);
  let overlayComponent: Component | undefined;
  const originalShowOverlay = tui.showOverlay.bind(tui);
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-enter", {
      description: "Custom enter selection smoke",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (_hostTui, _theme, keybindings, done) => ({
            render: () => ["select option"],
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.confirm")) done("selected");
            },
            invalidate: () => undefined,
          }),
          { overlay: true },
        );
        events.push(`result:${result}`);
      },
    });
  };

  tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
    overlayComponent = component;
    return originalShowOverlay(component, options);
  }) as typeof tui.showOverlay;

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost({ tui });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const task = runtime.prompt("s1", "/custom-enter");
    await waitFor(() => !!overlayComponent);
    overlayComponent!.handleInput?.("\r");
    await task;
    assert.deepEqual(events, ["result:selected"]);
  } finally {
    tui.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime scopes extension custom overlays to the active tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-tab-scope-"));
  const events: string[] = [];
  let overlayOptions: OverlayOptions | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("scoped-overlay", {
      description: "Scoped custom overlay smoke",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (_hostTui, _theme, keybindings, done) => ({
            render: () => ["scoped overlay for tab one"],
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.confirm")) done("selected");
            },
            invalidate: () => undefined,
          }),
          {
            overlay: true,
            overlayOptions: { margin: 1, width: "92%", maxHeight: "85%" },
          },
        );
        events.push(`result:${result}`);
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab1 = createTab(1, "s1", process.cwd());
    const tab2 = createTab(2, "s2", process.cwd());
    state.tabs.push(tab1, tab2);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(tab1, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(tab2, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    const originalShowOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
      overlayOptions = options;
      return originalShowOverlay(component, options);
    }) as typeof tui.showOverlay;
    try {
      const task = runtime.prompt("s1", "/scoped-overlay");
      await waitFor(() => typeof overlayOptions?.visible === "function");
      assert.deepEqual(tab1.extensionUi.pendingUserInteractions, [
        { id: "extension-custom-1", kind: "custom" },
      ]);
      assert.deepEqual(tab2.extensionUi.pendingUserInteractions, []);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      // Extension header now scrolls with the conversation, so the fixed top
      // chrome reserved for overlays is just the header logo + tab bar.
      const expectedTopMargin =
        renderHeader(80).length + renderTabBar(state, 80).length;
      assert.equal(overlayOptions?.width, "92%");
      assert.equal(overlayOptions?.maxHeight, "85%");
      assert.deepEqual(overlayOptions?.margin, {
        top: expectedTopMargin,
        right: 1,
        bottom: 1,
        left: 1,
      });
      assert.equal(overlayOptions?.visible?.(100, 24), true);

      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\t");
      assert.equal(state.activeTabId, "s2");
      assert.equal(overlayOptions?.visible?.(100, 24), false);
      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\r");
      assert.deepEqual(events, []);

      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\x1b[Z");
      assert.equal(state.activeTabId, "s1");
      assert.equal(overlayOptions?.visible?.(100, 24), true);
      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\r");
      await task;
      assert.deepEqual(events, ["result:selected"]);
      assert.equal(runtime.hasExtensionCustomOverlay("s1"), false);
      assert.deepEqual(tab1.extensionUi.pendingUserInteractions, []);
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
    } finally {
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime focuses extension custom overlay triggered while its tab was inactive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-inactive-focus-"));
  const events: string[] = [];
  let overlayShown = false;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("inactive-overlay", {
      description: "Custom overlay triggered from an inactive tab",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (_hostTui, _theme, keybindings, done) => ({
            render: () => ["overlay for tab one"],
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.confirm")) done("selected");
            },
            invalidate: () => undefined,
          }),
          { overlay: true },
        );
        events.push(`result:${result}`);
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab1 = createTab(1, "s1", process.cwd());
    const tab2 = createTab(2, "s2", process.cwd());
    state.tabs.push(tab1, tab2);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(tab1, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(tab2, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    const originalShowOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
      overlayShown = true;
      return originalShowOverlay(component, options);
    }) as typeof tui.showOverlay;
    const raw = (data: string) =>
      (tui as unknown as { handleInput: (data: string) => void }).handleInput(data);
    let task: Promise<void> | undefined;
    try {
      // Switch to tab two BEFORE the extension asks its question on tab one.
      // showOverlay skips focus capture for invisible overlays, so nothing
      // focuses the questionnaire unless MixCode restores focus on switch-back.
      raw("\t");
      assert.equal(state.activeTabId, "s2");
      task = runtime.prompt("s1", "/inactive-overlay");
      await waitFor(() => overlayShown);

      // While on another tab the hidden overlay must not react to keys.
      raw("\r");
      assert.deepEqual(events, []);

      // Switching back must hand focus to the pending overlay: the first
      // Enter after the switch selects instead of leaking to the editor.
      raw("\x1b[Z");
      assert.equal(state.activeTabId, "s1");
      raw("\r");
      await waitFor(() => events.length > 0);
      await task;
      assert.deepEqual(events, ["result:selected"]);
      assert.equal(runtime.hasExtensionCustomOverlay("s1"), false);
      assert.deepEqual(tab1.extensionUi.pendingUserInteractions, []);
    } finally {
      // Settle the pending ui.custom promise if the assertions above failed.
      runtime.setExtensionUiHost(undefined);
      await task?.catch(() => undefined);
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps pi extension custom non-overlay into the live editor slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-editor-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-editor", {
      description: "Custom editor smoke",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>((hostTui, theme, keybindings, done) => {
          events.push(`host:${hostTui !== undefined}`);
          events.push(`kb:${keybindings.getKeys("tui.select.cancel").join("+")}`);
          let value = "custom";
          return {
            render: (width: number) => [theme.fg("accent", `editor ${value} ${width}`)],
            onInput: (data: string) => {
              if (data === "x") {
                value = "updated";
                hostTui.requestRender();
                return;
              }
              if (data === "\r") done(value);
            },
            invalidate: () => events.push("invalidate"),
            dispose: () => events.push("dispose"),
          };
        });
        events.push(`result:${result}`);
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab = createTab(1, "s1", process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    try {
      const promptTask = runtime.prompt("s1", "/custom-editor");
      await waitFor(() => /editor custom 80/.test(stripAnsi(tui.render(80).join("\n"))));
      assert.equal(runtime.hasExtensionCustomOverlay("s1"), true);
      assert.deepEqual(tab.extensionUi.pendingUserInteractions, [
        { id: "extension-custom-1", kind: "custom" },
      ]);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      assert.deepEqual(events.slice(0, 2), ["host:true", "kb:escape"]);

      (tui as unknown as { handleInput: (data: string) => void }).handleInput("x");
      await waitFor(() => /editor updated 80/.test(stripAnsi(tui.render(80).join("\n"))));
      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\r");
      await promptTask;

      assert.equal(runtime.hasExtensionCustomOverlay("s1"), false);
      assert.deepEqual(tab.extensionUi.pendingUserInteractions, []);
      assert.ok(events.includes("dispose"));
      assert.ok(events.includes("result:updated"));
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      const restoredEditor = stripAnsi(tui.render(80).join("\n"));
      assert.match(restoredEditor, /Send message to Agent-01\.\.\./);
      assert.match(restoredEditor, /─{10,}/);
      assert.doesNotMatch(stripAnsi(tui.render(80).join("\n")), /editor updated/);
    } finally {
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime scopes extension custom non-overlay editors to their owning tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-editor-scope-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-editor", {
      description: "Scoped custom editor smoke",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>((hostTui, _theme, keybindings, done) => {
          let value = "tab-one";
          return {
            render: (width: number) => [`scoped editor ${value} ${width}`],
            onInput: (data: string) => {
              if (data === "x") {
                value = "updated";
                hostTui.requestRender();
                return;
              }
              if (keybindings.matches(data, "tui.select.confirm")) done(value);
            },
            invalidate: () => undefined,
            dispose: () => events.push("dispose"),
          };
        });
        events.push(`result:${result}`);
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab1 = createTab(1, "s1", process.cwd());
    const tab2 = createTab(2, "s2", process.cwd());
    state.tabs.push(tab1, tab2);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(tab1, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(tab2, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    try {
      const promptTask = runtime.prompt("s1", "/custom-editor");
      await waitFor(() => /scoped editor tab-one 80/.test(stripAnsi(tui.render(80).join("\n"))));
      assert.deepEqual(tab1.extensionUi.pendingUserInteractions, [
        { id: "extension-custom-1", kind: "custom" },
      ]);
      assert.deepEqual(tab2.extensionUi.pendingUserInteractions, []);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);

      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\t");
      assert.equal(state.activeTabId, "s2");
      assert.doesNotMatch(stripAnsi(tui.render(80).join("\n")), /scoped editor/);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\r");
      assert.deepEqual(events, []);

      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\x1b[Z");
      assert.equal(state.activeTabId, "s1");
      assert.match(stripAnsi(tui.render(80).join("\n")), /scoped editor tab-one 80/);
      (tui as unknown as { handleInput: (data: string) => void }).handleInput("x");
      await waitFor(() => /scoped editor updated 80/.test(stripAnsi(tui.render(80).join("\n"))));
      (tui as unknown as { handleInput: (data: string) => void }).handleInput("\r");
      await promptTask;

      assert.deepEqual(events, ["dispose", "result:updated"]);
      assert.deepEqual(tab1.extensionUi.pendingUserInteractions, []);
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      assert.doesNotMatch(stripAnsi(tui.render(80).join("\n")), /scoped editor/);
    } finally {
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime tracks concurrent extension custom interactions independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-custom-concurrent-"));
  const events: string[] = [];
  const overlayComponents: Component[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-first", {
      description: "First custom overlay",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (_hostTui, _theme, keybindings, done) => ({
            render: () => ["first custom"],
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.confirm")) done("first");
            },
            invalidate: () => undefined,
          }),
          { overlay: true },
        );
        events.push(`first:${result}`);
      },
    });
    pi.registerCommand("custom-second", {
      description: "Second custom overlay",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (_hostTui, _theme, keybindings, done) => ({
            render: () => ["second custom"],
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.confirm")) done("second");
            },
            invalidate: () => undefined,
          }),
          { overlay: true },
        );
        events.push(`second:${result}`);
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab = createTab(1, "s1", process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    const originalShowOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
      overlayComponents.push(component);
      return originalShowOverlay(component, options);
    }) as typeof tui.showOverlay;
    try {
      const firstTask = runtime.prompt("s1", "/custom-first");
      const secondTask = runtime.prompt("s1", "/custom-second");
      await waitFor(() => overlayComponents.length === 2);
      assert.deepEqual(tab.extensionUi.pendingUserInteractions, [
        { id: "extension-custom-1", kind: "custom" },
        { id: "extension-custom-2", kind: "custom" },
      ]);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);

      overlayComponents[0]!.handleInput?.("\r");
      await waitFor(() => tab.extensionUi.pendingUserInteractions.length === 1);
      assert.deepEqual(tab.extensionUi.pendingUserInteractions, [
        { id: "extension-custom-2", kind: "custom" },
      ]);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);

      overlayComponents[1]!.handleInput?.("\r");
      await firstTask;
      await secondTask;
      assert.deepEqual(events, ["first:first", "second:second"]);
      assert.deepEqual(tab.extensionUi.pendingUserInteractions, []);
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
    } finally {
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
