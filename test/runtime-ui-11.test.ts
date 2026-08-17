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
  renderHeader,
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
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

test("runtime merges resource loader and runtime extension factories across workdir reloads", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-reload-"));
  const events: string[] = [];
  const first: ExtensionFactory = (pi) => {
    pi.registerCommand("first", { description: "First command", handler: async () => undefined });
    pi.on("session_start", (event) => events.push(`first:${event.reason}`));
    pi.on("session_shutdown", (event) => events.push(`first-shutdown:${event.reason}`));
  };
  const second: ExtensionFactory = (pi) => {
    pi.registerCommand("second", { description: "Second command", handler: async () => undefined });
    pi.on("session_start", (event) => events.push(`second:${event.reason}`));
    pi.on("session_shutdown", (event) => events.push(`second-shutdown:${event.reason}`));
  };

  try {
    const oldDir = path.join(dir, "old");
    const newDir = path.join(dir, "new");
    await fsPromises.mkdir(oldDir, { recursive: true });
    await fsPromises.mkdir(newDir, { recursive: true });
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      resourceLoaderOptions: { extensionFactories: [first] },
      extensionFactories: [second],
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", oldDir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: oldDir,
    });

    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "first"));
    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "second"));
    assert.deepEqual(events, ["first:startup", "second:startup"]);

    await runtime.updateTabWorkdir("s1", newDir, "system");
    assert.equal(runtimeTab.tab.workdir, newDir);
    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "first"));
    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "second"));
    assert.deepEqual(events, [
      "first:startup",
      "second:startup",
      "first-shutdown:reload",
      "second-shutdown:reload",
      "first:reload",
      "second:reload",
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime emits pi extension shutdown on close, close-all, delete, delete-all, and clear", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-shutdown-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_shutdown", (event, ctx) => {
      events.push(
        `${ctx.sessionManager?.getSessionId()}:${event.reason}:${event.targetSessionFile ? "target" : "none"}`,
      );
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "close", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.closeTab("close");

    await runtime.createTab(createTab(1, "close-all-a", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(2, "close-all-b", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.closeAllTabs();
    assert.equal(runtime.listTabs().length, 0);

    await runtime.createTab(createTab(1, "delete", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.deleteTab("delete");

    await runtime.createTab(createTab(1, "clear", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.clearTab("clear", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "clear-next",
    });

    await runtime.createTab(createTab(1, "all-a", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(2, "all-b", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.deleteAllTabs();

    assert.deepEqual(events, [
      "close:quit:none",
      "close-all-a:quit:none",
      "close-all-b:quit:none",
      "delete:quit:none",
      "clear:new:target",
      "clear-next:quit:none",
      "all-a:quit:none",
      "all-b:quit:none",
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime exposes editor component replacement as an explicit error without a live TUI host", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-ui-"));
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setEditorComponent(() => ({
        render: () => [],
        invalidate: () => undefined,
        getText: () => "",
        setText: () => undefined,
        handleInput: () => undefined,
      }));
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.ok(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes("Pi extension UI editor is not available in MixCode yet"),
      ),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps pi extension custom overlay into a live TUI overlay", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-overlay-"));
  const events: string[] = [];
  const terminal = silentTerminal();
  const tui = new TuiMainScreen(terminal);
  const overlayRenders: string[] = [];
  const overlayOptions: OverlayOptions[] = [];
  let overlayComponent: Component | undefined;
  let overlayOpen = false;
  const originalShowOverlay = tui.showOverlay.bind(tui);
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-smoke", {
      description: "Custom overlay smoke",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>(
          (hostTui, theme, keybindings, done) => {
            events.push(`host:${hostTui === tui}`);
            events.push(`kb:${keybindings.getKeys("tui.select.cancel").join("+")}`);
            let value = "initial";
            return {
              render: (width: number) => [theme.fg("accent", `custom ${value} ${width}`)],
              onInput: (data: string) => {
                if (data === "x") {
                  value = "updated";
                  hostTui.requestRender();
                  return;
                }
                if (data === "\r") done(value);
              },
              invalidate: () => undefined,
              dispose: () => events.push("dispose"),
            };
          },
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
            onHandle: (handle) => events.push(`handle:${handle.isFocused()}`),
          },
        );
        events.push(`result:${result}`);
      },
    });
  };

  tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
    overlayOpen = true;
    overlayComponent = component;
    overlayRenders.push(component.render(100).join("\n"));
    if (options) overlayOptions.push(options);
    const handle = originalShowOverlay(component, options);
    const originalHide = handle.hide.bind(handle);
    return {
      ...handle,
      hide: () => {
        overlayOpen = false;
        originalHide();
      },
    };
  }) as typeof tui.showOverlay;

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost({ tui });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const promptTask = runtime.prompt("s1", "/custom-smoke");
    await waitFor(() => overlayOpen && !!overlayComponent);
    assert.equal(runtime.hasExtensionCustomOverlay("s1"), true);
    assert.equal(stripAnsi(overlayRenders[0] ?? ""), "custom initial 100");
    assert.deepEqual(overlayOptions[0], { anchor: "center", width: 84, maxHeight: "80%" });
    assert.deepEqual(events.slice(0, 3), ["host:true", "kb:escape", "handle:true"]);

    overlayComponent!.handleInput?.("x");
    overlayRenders.push(overlayComponent!.render(100).join("\n"));
    assert.equal(stripAnsi(overlayRenders.at(-1) ?? ""), "custom updated 100");

    overlayComponent!.handleInput?.("\r");
    await promptTask;
    assert.equal(overlayOpen, false);
    assert.equal(runtime.hasExtensionCustomOverlay("s1"), false);
    assert.ok(events.includes("dispose"));
    assert.ok(events.includes("result:updated"));
  } finally {
    tui.stop();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
