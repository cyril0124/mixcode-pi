import "./helpers/isolated-agent-dir.js";
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
  mixcodeFauxStream,
  padLine,
  renderChat,
  renderCommandPalette,
  renderConfig,
  renderExportChooser,
  renderExportText,
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

test("runtime loads pi extension factories, tools, commands, and lifecycle hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "extension_echo",
      label: "Echo",
      description: "Echoes text for MixCode extension smoke tests.",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: `echo:${params.text}` }],
        details: params,
      }),
    });
    pi.registerCommand("hello", {
      description: "Smoke-test command",
      getArgumentCompletions: (prefix) =>
        prefix === "wo" ? [{ value: "world", label: "world" }] : null,
      handler: async (args, ctx) => {
        events.push(`command:${args}`);
        ctx.ui.notify("plain notice");
        pi.sendMessage({ customType: "extension-note", content: `hello ${args}`, display: true });
      },
    });
    pi.registerMessageRenderer(
      "extension-note",
      (message) => new Text(`rendered ${message.content}`, 0, 0),
    );
    pi.on("session_start", (event, ctx) => {
      events.push(`start:${event.reason}`);
      ctx.ui.notify("extension ready", "warning");
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.ok(runtimeTab.extensionsResult.extensions.length >= 1);
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "extension_echo"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "read"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "bash"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "edit"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "write"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "grep"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "find"));
    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "ls"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("extension_echo"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("read"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("bash"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("edit"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("write"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("grep"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("find"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("ls"));
    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "hello"));
    assert.ok(runtime.getAllExtensionCommands().some((command) => command.name === "hello"));
    assert.ok(runtime.getExtensionTools("s1").some((tool) => tool.name === "extension_echo"));
    assert.deepEqual(
      runtime
        .getAllExtensionCommands()
        .filter((command) => command.name === "hello")
        .map((command) => command.description),
      ["Smoke-test command"],
    );
    assert.deepEqual(
      runtime
        .getAllExtensionCommands()
        .filter((command) => command.name === "hello")
        .map((command) => command.sourceInfo?.source),
      ["inline"],
    );
    assert.deepEqual(
      await runtime
        .getExtensionCommands("s1")
        .find((command) => command.name === "hello")
        ?.getArgumentCompletions?.("wo"),
      [{ value: "world", label: "world" }],
    );
    assert.deepEqual(events, ["start:startup"]);
    assert.ok(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" && line.text.includes("Extension warning: extension ready"),
      ),
    );

    await runtime.prompt("s1", "/hello world");
    assert.ok(events.includes("command:world"));
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.text.includes("Extension: plain notice"),
      ),
    );
    const extensionLine = runtimeTab.chat.find(
      (line) => line.role === "extension" && line.customType === "extension-note",
    );
    assert.ok(extensionLine);
    assert.match(extensionLine.text, /hello world/);
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /rendered hello world/,
    );
    assert.ok(renderAgentSurface(runtimeTab.tab, runtimeTab, 0).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps extension runtimes isolated across same-workdir tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-isolation-"));
  const extension: ExtensionFactory = (pi) => {
    pi.registerMessageRenderer("isolation-note", (message) => new Text(String(message.content), 0, 0));
    pi.registerCommand("poke", {
      description: "Exercise a command that uses its captured pi API.",
      handler: async () => {
        pi.sendMessage({ customType: "isolation-note", content: "still alive", display: true });
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const workdir = process.cwd();
    const first = await runtime.createTab(createTab(1, "s1", workdir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir,
    });
    const second = await runtime.createTab(createTab(2, "s2", workdir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir,
    });

    assert.notEqual(first.extensionsResult.runtime, second.extensionsResult.runtime);

    first.agentSession.dispose();
    await runtime.prompt("s2", "/poke");

    assert.ok(
      second.chat.some((line) => line.role === "extension" && line.text.includes("still alive")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension terminal input and UI setters expose exact state changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-terminal-ui-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("terminal-ui", {
      description: "Terminal input and UI state smoke",
      handler: async (_args, ctx) => {
        ctx.ui.onTerminalInput((data) =>
          data === "drop" ? { consume: true } : data === "map" ? { data: "mapped" } : undefined,
        );
        ctx.ui.onTerminalInput((data) => (data === "mapped" ? { data: "" } : undefined));
        ctx.ui.setStatus("state", "ready\nnow");
        ctx.ui.setStatus("state", "ready");
        ctx.ui.setWorkingMessage();
        ctx.ui.setWorkingIndicator();
        ctx.ui.setHiddenThinkingLabel();
        ctx.ui.setWidget("string", ["line\tone", "", "\x1b[31mred\x1b[39m"], {
          placement: "belowEditor",
        });
        ctx.ui.setWidget("factory", (tui, theme) => ({
          render: () => [theme.fg("accent", `factory:${tui.terminal.columns}`)],
          invalidate: () => events.push("factory-invalidate"),
          dispose: () => events.push("factory-dispose"),
        }));
        ctx.ui.setFooter(undefined);
        ctx.ui.setHeader(undefined);
        ctx.ui.setTitle("Extension Title");
        ctx.ui.setToolsExpanded(false);
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    await runtime.prompt("s1", "/terminal-ui");

    assert.equal(runtime.dispatchTerminalInput("missing", "drop"), undefined);
    assert.deepEqual(runtime.dispatchTerminalInput("s1", "drop"), { consume: true });
    assert.deepEqual(runtime.dispatchTerminalInput("s1", "map"), { data: "" });
    assert.equal(runtime.dispatchTerminalInput("s1", "plain"), undefined);
    assert.deepEqual(runtimeTab.tab.extensionUi.statuses, [{ key: "state", text: "ready" }]);
    assert.equal(runtimeTab.tab.extensionUi.workingMessage, undefined);
    assert.equal(runtimeTab.tab.extensionUi.workingIndicatorFrames, undefined);
    assert.equal(runtimeTab.tab.extensionUi.workingIndicatorIntervalMs, undefined);
    assert.equal(runtimeTab.tab.extensionUi.toolsExpanded, false);
    assert.equal(runtimeTab.tab.extensionUi.title, "Extension Title");
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 40, "aboveEditor").join("\n"),
      /factory:38/,
    );
    assert.match(renderExtensionWidgets(runtimeTab.tab, 40, "belowEditor").join("\n"), /line one/);
    assert.match(renderExtensionWidgets(runtimeTab.tab, 40, "belowEditor").join("\n"), /red/);
    assert.deepEqual(events, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension manager disables extension entries across reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-manager-"));
  let disabledExtensionKeys: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "managed_tool",
      label: "Managed",
      description: "Managed extension tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "managed" }], details: {} }),
    });
    pi.registerCommand("managed", {
      description: "Managed extension command",
      handler: async () => undefined,
    });
  };

  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      extensionFactories: [extension],
      extensionManagerStore: {
        load: async () => ({ version: 1, disabledExtensionKeys }),
        save: async (config) => {
          disabledExtensionKeys = config.disabledExtensionKeys;
        },
      },
    });
    await runtime.loadExtensionManagerConfig();
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "managed"));
    assert.ok(runtime.getExtensionTools("s1").some((tool) => tool.name === "managed_tool"));
    const entry = runtime.getExtensionManagerEntries("s1").find((item) => item.source === "inline");
    assert.ok(entry);
    assert.equal(entry.enabled, true);
    assert.equal(entry.toolCount, 1);
    assert.equal(entry.commandCount, 1);

    await runtime.setExtensionEnabled("s1", entry.key, false);
    assert.deepEqual(disabledExtensionKeys, [entry.key]);
    const result = await runtime.reloadExtensionManagerTab("s1");

    assert.equal(result.status, "reloaded");
    assert.equal(
      runtime.getExtensionCommands("s1").some((command) => command.name === "managed"),
      false,
    );
    assert.equal(
      runtime.getExtensionTools("s1").some((tool) => tool.name === "managed_tool"),
      false,
    );
    assert.equal(
      runtimeTab.extensionsResult.extensions.some(
        (extension) => extension.sourceInfo.source === "inline",
      ),
      false,
    );
    assert.equal(
      runtime.getExtensionManagerEntries("s1").find((item) => item.key === entry.key)?.enabled,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension manager disables extensions for new tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-manager-cache-"));
  let disabledExtensionKeys: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "managed_tool",
      label: "Managed",
      description: "Managed extension tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "managed" }], details: {} }),
    });
    pi.registerCommand("managed", {
      description: "Managed extension command",
      handler: async () => undefined,
    });
  };

  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      extensionFactories: [extension],
      extensionManagerStore: {
        load: async () => ({ version: 1, disabledExtensionKeys }),
        save: async (config) => {
          disabledExtensionKeys = config.disabledExtensionKeys;
        },
      },
    });
    await runtime.loadExtensionManagerConfig();
    const workdir = process.cwd();
    await runtime.createTab(createTab(1, "s1", workdir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir,
    });

    const entry = runtime.getExtensionManagerEntries("s1").find((item) => item.source === "inline");
    assert.ok(entry);
    await runtime.setExtensionEnabled("s1", entry.key, false);

    await runtime.createTab(createTab(2, "s2", workdir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir,
    });

    assert.equal(
      runtime.getExtensionCommands("s2").some((command) => command.name === "managed"),
      false,
    );
    assert.equal(
      runtime.getExtensionTools("s2").some((tool) => tool.name === "managed_tool"),
      false,
    );
    assert.equal(
      runtime.getExtensionManagerEntries("s2").find((item) => item.key === entry.key)?.enabled,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension factory widgets render live state after requestRender", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-live-widget-"));
  let count = 0;
  let widgetTui: TUI | undefined;
  let renderRequests = 0;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setWidget("live", (tui, theme) => {
        widgetTui = tui;
        return {
          render: () => [theme.fg("accent", `Todos (${count}/5)`)],
          invalidate: () => undefined,
          dispose: () => undefined,
        };
      });
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    let runtimeChanges = 0;
    runtime.onChange(() => {
      runtimeChanges += 1;
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.match(
      stripAnsi(renderExtensionWidgets(runtimeTab.tab, 80, "aboveEditor").join("\n")),
      /Todos \(0\/5\)/,
    );
    count = 1;
    widgetTui?.requestRender();
    renderRequests += 1;
    assert.match(
      stripAnsi(renderExtensionWidgets(runtimeTab.tab, 80, "aboveEditor").join("\n")),
      /Todos \(1\/5\)/,
    );
    assert.equal(renderRequests, 1);
    assert.equal(runtimeChanges > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension reload resets host UI state and rebinds extension resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-command-reload-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (event, ctx) => {
      events.push(`start:${event.reason}`);
      ctx.ui.setStatus("state", event.reason);
      ctx.ui.setWidget("reload-widget", [`widget:${event.reason}`]);
      ctx.ui.setWorkingMessage(`working:${event.reason}`);
      ctx.ui.setEditorComponent(
        (tui) => new Text(`editor:${event.reason}:${tui.terminal.columns}`, 0, 0),
      );
      ctx.ui.addAutocompleteProvider((current) => ({
        getSuggestions: async (lines, cursorLine, cursorCol, options) => {
          if ((lines[cursorLine] ?? "").startsWith("#")) {
            return { prefix: "#", items: [{ value: `#${event.reason}`, label: event.reason }] };
          }
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
          current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      }));
      ctx.ui.onTerminalInput((data) => (data === "reload-key" ? { consume: true } : undefined));
    });
    pi.on("session_shutdown", (event) => events.push(`shutdown:${event.reason}`));
    pi.registerCommand("reload-smoke", {
      description: "Reload host state smoke",
      handler: async (_args, ctx) => {
        await ctx.reload();
        events.push("after-reload");
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    let editorFactory: unknown;
    let activeProvider: AutocompleteProvider = new MixCodeCompletionProvider({
      skills: [],
      files: [],
    });
    runtime.setExtensionUiHost({
      tui: new TUI(silentTerminal()),
      editor: {
        getText: () => "",
        setText: () => undefined,
        pasteToEditor: () => undefined,
        setAutocompleteProvider: (provider) => {
          activeProvider = provider;
        },
        setEditorComponent: (factory) => {
          editorFactory = factory;
        },
      },
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    activeProvider = runtime.applyExtensionAutocompleteProviders("s1", activeProvider);
    assert.deepEqual(
      await activeProvider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal }),
      { prefix: "#", items: [{ value: "#startup", label: "startup" }] },
    );
    assert.equal(runtime.dispatchTerminalInput("s1", "reload-key")?.consume, true);
    assert.equal(runtimeTab.tab.extensionUi.statuses[0]?.text, "startup");
    assert.equal(runtimeTab.tab.extensionUi.workingMessage, "working:startup");
    assert.ok(
      runtimeTab.tab.extensionUi.widgets.some((widget) => widget.lines.includes("widget:startup")),
    );
    assert.equal(typeof editorFactory, "function");

    await runtime.prompt("s1", "/reload-smoke");

    assert.equal(runtime.dispatchTerminalInput("s1", "reload-key")?.consume, true);
    assert.deepEqual(runtimeTab.tab.extensionUi.statuses, [{ key: "state", text: "reload" }]);
    assert.equal(runtimeTab.tab.extensionUi.workingMessage, "working:reload");
    assert.deepEqual(
      runtimeTab.tab.extensionUi.widgets
        .filter((widget) => widget.key !== "bg-sessions")
        .map((widget) => widget.lines[0]),
      ["widget:reload"],
    );
    assert.deepEqual(
      await runtime
        .applyExtensionAutocompleteProviders(
          "s1",
          new MixCodeCompletionProvider({ skills: [], files: [] }),
        )
        .getSuggestions(["#"], 0, 1, { signal: new AbortController().signal }),
      { prefix: "#", items: [{ value: "#reload", label: "reload" }] },
    );
    assert.deepEqual(events, ["start:startup", "shutdown:reload", "start:reload", "after-reload"]);
    assert.equal(typeof editorFactory, "function");
    runtime.setExtensionUiHost(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Factory widgets (e.g. pi-subagents FleetView) emit intentional blank lines as
// vertical separators. Pi's native widget container preserves them; mixcode must
// match, so interior blank rows survive widget rendering instead of being
// collapsed away. Regression guard for the missing FleetView hint/main gap.
test("runtime preserves interior blank lines in factory widgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-widget-blank-"));
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("blank-widget", {
      description: "Widget with an interior blank separator line",
      handler: async (_args, ctx) => {
        ctx.ui.setWidget(
          "fleet-like",
          (_tui, theme) => ({
            render: () => [theme.fg("dim", "hint"), "", theme.fg("accent", "main")],
            invalidate: () => undefined,
          }),
          { placement: "belowEditor" },
        );
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    await runtime.prompt("s1", "/blank-widget");

    const widget = runtimeTab.tab.extensionUi.widgets.find((w) => w.key === "fleet-like");
    assert.ok(widget, "widget should be registered");
    // Stored snapshot keeps the interior blank line (3 rows, middle is blank).
    assert.equal(widget?.lines.length, 3);
    assert.equal((widget?.lines[1] ?? "x").trim(), "");
    // Live render preserves the blank row too, so the on-screen gap survives.
    const rendered = renderExtensionWidgets(runtimeTab.tab, 40, "belowEditor");
    assert.equal(rendered.length, 3);
    assert.equal(stripAnsi(rendered[1] ?? "x").trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
