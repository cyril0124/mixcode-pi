import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
import { Markdown, Text, TuiMainScreen, visibleWidth, type AutocompleteProvider, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
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
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderTabBar,
  renderTabJumpOverlay,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
  themeForId,
} from "./helpers/mixcode.js";

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
    await Bun.sleep(10);
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

test("runtime custom non-overlay editor exposes missing host and teardown paths", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-editor-edges-"));
  const events: string[] = [];
  let releaseFactory: (() => void) | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-editor-no-host", {
      description: "Custom editor without editor host",
      handler: async (_args, ctx) => {
        try {
          await ctx.ui.custom<string>(() => ({ render: () => [], invalidate: () => undefined }));
        } catch (error) {
          events.push(`no-host:${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    pi.registerCommand("custom-editor-delayed", {
      description: "Custom delayed editor",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(async () => {
          await new Promise<void>((resolve) => {
            releaseFactory = resolve;
          });
          return {
            render: () => ["delayed editor"],
            invalidate: () => undefined,
            dispose: () => events.push("delayed-editor-dispose"),
          };
        });
        events.push(`delayed:${result ?? "none"}`);
      },
    });
    pi.registerCommand("custom-editor-throws", {
      description: "Custom editor factory throws",
      handler: async (_args, ctx) => {
        try {
          await ctx.ui.custom<string>(() => {
            throw new Error("broken custom editor");
          });
        } catch (error) {
          events.push(`throws:${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    await runtime.prompt("s1", "/custom-editor-no-host");
    assert.match(events.at(-1) ?? "", /requires an active MixCode TUI host: custom/);
    runtime.setExtensionUiHost({ tui: new TuiMainScreen(silentTerminal()) });
    await runtime.prompt("s1", "/custom-editor-no-host");
    assert.match(events.at(-1) ?? "", /editor component replacement is not available/);

    const state = createInitialState(process.cwd());
    const tab = createTab(1, "s1", process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    try {
      await runtime.prompt("s1", "/custom-editor-throws");
      assert.ok(events.includes("throws:broken custom editor"));

      const delayedTask = runtime.prompt("s1", "/custom-editor-delayed");
      await waitFor(() => typeof releaseFactory === "function");
      runtime.setExtensionUiHost(undefined);
      releaseFactory?.();
      await delayedTask;
      assert.ok(events.includes("delayed:none"));
      assert.ok(events.includes("delayed-editor-dispose"));
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime custom overlay exposes host and delayed-close paths", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-overlay-edges-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-no-host", {
      description: "Custom overlay without live host",
      handler: async (_args, ctx) => {
        try {
          await ctx.ui.custom<string>(() => ({ render: () => [], invalidate: () => undefined }), {
            overlay: true,
          });
        } catch (error) {
          events.push(`no-host:${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    pi.registerCommand("custom-delayed", {
      description: "Custom delayed overlay",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          async () => {
            await Bun.sleep(5);
            return {
              width: 42,
              render: () => ["delayed"],
              handleInput: (data: string) => events.push(`input:${data}`),
              invalidate: () => undefined,
              dispose: () => events.push("delayed-dispose"),
            };
          },
          { overlay: true },
        );
        events.push(`delayed:${result ?? "none"}`);
      },
    });
    pi.registerCommand("custom-options-factory", {
      description: "Custom overlay option factory",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (_tui, _theme, _keybindings, done) => ({
            render: () => ["factory options"],
            onInput: () => done("ok"),
            invalidate: () => undefined,
            dispose: () => events.push("factory-dispose"),
          }),
          {
            overlay: true,
            overlayOptions: () => ({ anchor: "bottom", width: 33 }),
          },
        );
        events.push(`factory:${result}`);
      },
    });
    pi.registerCommand("custom-throws", {
      description: "Custom overlay factory throws",
      handler: async (_args, ctx) => {
        try {
          await ctx.ui.custom<string>(
            () => {
              throw new Error("broken custom overlay");
            },
            { overlay: true },
          );
        } catch (error) {
          events.push(`throws:${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  };
  const terminal = silentTerminal();
  const tui = new TuiMainScreen(terminal);
  const overlayOptions: OverlayOptions[] = [];
  let overlayComponent: Component | undefined;
  const originalShowOverlay = tui.showOverlay.bind(tui);
  tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
    overlayComponent = component;
    if (options) overlayOptions.push(options);
    return originalShowOverlay(component, options);
  }) as typeof tui.showOverlay;

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    await runtime.prompt("s1", "/custom-no-host");
    assert.match(events.at(-1) ?? "", /requires an active MixCode TUI host: custom/);

    runtime.setExtensionUiHost({ tui });
    const delayedTask = runtime.prompt("s1", "/custom-delayed");
    await waitFor(() => runtime.hasExtensionCustomOverlay("s1"));
    runtime.setExtensionUiHost(undefined);
    await delayedTask;
    assert.ok(events.includes("delayed:none"));
    await waitFor(() => events.includes("delayed-dispose"));
    assert.ok(events.includes("delayed-dispose"));

    runtime.setExtensionUiHost({ tui });
    const optionsBeforeFactory = overlayOptions.length;
    const factoryTask = runtime.prompt("s1", "/custom-options-factory");
    // Wait for THIS prompt's showOverlay, not a leftover component from delayed.
    await waitFor(() => overlayOptions.length > optionsBeforeFactory);
    assert.deepEqual(overlayOptions.at(-1), { anchor: "bottom", width: 33 });
    overlayComponent!.handleInput?.("x");
    await factoryTask;
    assert.ok(events.includes("factory:ok"));
    assert.ok(events.includes("factory-dispose"));

    await runtime.prompt("s1", "/custom-throws");
    assert.ok(events.includes("throws:broken custom overlay"));
  } finally {
    tui.stop();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps pi extension editor text primitives into the active MixCode editor", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-editor-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("editor-smoke", {
      description: "Editor primitive smoke",
      handler: async (_args, ctx) => {
        events.push(`before:${ctx.ui.getEditorText()}`);
        ctx.ui.setEditorText("hello");
        events.push(`after-set:${ctx.ui.getEditorText()}`);
        ctx.ui.pasteToEditor("\nworld");
        events.push(`after-paste:${ctx.ui.getEditorText()}`);
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
      await runtime.prompt("s1", "/editor-smoke");
      assert.deepEqual(events, ["before:", "after-set:hello", "after-paste:hello\nworld"]);
      assert.match(tui.render(80).join("\n"), /world/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps pi extension editor component into the active MixCode editor slot", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-editor-component-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("editor-component", {
      description: "Editor component primitive smoke",
      handler: async (_args, ctx) => {
        const factory = () => {
          let text = "";
          return {
            render: (width: number) => [`custom-editor:${text}:${width}`],
            invalidate: () => undefined,
            getText: () => text,
            getExpandedText: () => `${text}:expanded`,
            setText: (next: string) => {
              text = next;
            },
            insertTextAtCursor: (chunk: string) => {
              text += chunk;
            },
            handleInput: (data: string) => {
              const pasteMatch = data.match(/\x1b\[200~([\s\S]*)\x1b\[201~/);
              if (pasteMatch) {
                text += pasteMatch[1] ?? "";
                return;
              }
              text += data;
            },
            addToHistory: (item: string) => events.push(`history:${item}`),
          };
        };
        ctx.ui.setEditorText("seed");
        ctx.ui.setEditorComponent(factory);
        events.push(`factory-set:${ctx.ui.getEditorComponent() === factory}`);
        events.push(`initial:${ctx.ui.getEditorText()}`);
        ctx.ui.setEditorText("custom");
        ctx.ui.pasteToEditor("!");
        events.push(`after:${ctx.ui.getEditorText()}`);
        ctx.ui.setEditorComponent(undefined);
        events.push(`factory-cleared:${ctx.ui.getEditorComponent() === undefined}`);
        events.push(`restored:${ctx.ui.getEditorText()}`);
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
      await runtime.prompt("s1", "/editor-component");
      assert.deepEqual(events, [
        "factory-set:true",
        "initial:seed:expanded",
        "after:custom!:expanded",
        "factory-cleared:true",
        "restored:custom!:expanded",
      ]);
      assert.match(tui.render(80).join("\n"), /custom!/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps custom() editor text primitives on the underlying editor", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-runtime-custom-editor-text-"),
  );
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("btw-bring", {
      description: "Bring-to-main editor text contract",
      handler: async (_args, ctx) => {
        ctx.ui.setEditorText("old-draft");
        let live = ctx.ui.getEditorText();
        await ctx.ui.custom((_tui, _theme, _keys, done) => ({
          render: () => ["btw-ui"],
          handleInput: (data: string) => {
            if (data !== "r") return;
            events.push(`during-open:${ctx.ui.getEditorText()}`);
            ctx.ui.setEditorText("btw-context");
            events.push(`during-set:${ctx.ui.getEditorText()}`);
            live = ctx.ui.getEditorText();
            done("ok");
          },
          invalidate: () => undefined,
        }));
        events.push(`after-close:${ctx.ui.getEditorText()}`);
        if (ctx.ui.getEditorText() !== live) ctx.ui.setEditorText(live);
        events.push(`after-restore:${ctx.ui.getEditorText()}`);
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
      const editor = (
        tui as unknown as {
          children: Array<{ editor: { handleInput(data: string): void } }>;
        }
      ).children[0]!.editor;
      const task = runtime.prompt("s1", "/btw-bring");
      await waitFor(() => tui.render(80).join("\n").includes("btw-ui"));
      editor.handleInput("r");
      await task;
      assert.deepEqual(events, [
        "during-open:old-draft",
        "during-set:btw-context",
        "after-close:old-draft",
        "after-restore:btw-context",
      ]);
      assert.match(tui.render(80).join("\n"), /btw-context/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
