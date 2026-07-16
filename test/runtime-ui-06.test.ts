import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text, TUI, type AutocompleteProvider, type Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeCompletionProvider,
  MixCodeRuntime,
  createTab,
  renderAgentSurface,
  renderExtensionWidgets,
} from "../src/index.js";

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

test("runtime loads extension tools, commands, and lifecycle hooks", async () => {
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
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "extension_echo"));
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("read"));
    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "hello"));
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
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /rendered hello world/,
    );
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
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("terminal-ui", {
      description: "Terminal input and UI state smoke",
      handler: async (_args, ctx) => {
        ctx.ui.onTerminalInput((data) =>
          data === "drop" ? { consume: true } : data === "map" ? { data: "mapped" } : undefined,
        );
        ctx.ui.onTerminalInput((data) => (data === "mapped" ? { data: "" } : undefined));
        ctx.ui.setStatus("state", "ready");
        ctx.ui.setTitle("Extension Title");
        ctx.ui.setToolsExpanded(false);
        ctx.ui.setWidget("string", ["line one", "red"], { placement: "belowEditor" });
        ctx.ui.setWidget("factory", (tui, theme) => ({
          render: () => [theme.fg("accent", `factory:${tui.terminal.columns}`)],
          invalidate: () => undefined,
          dispose: () => undefined,
        }));
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

    await runtime.prompt("s1", "/terminal-ui");

    assert.deepEqual(runtime.dispatchTerminalInput("s1", "drop"), { consume: true });
    assert.deepEqual(runtime.dispatchTerminalInput("s1", "map"), { data: "" });
    assert.equal(runtime.dispatchTerminalInput("s1", "plain"), undefined);
    assert.deepEqual(runtimeTab.tab.extensionUi.statuses, [{ key: "state", text: "ready" }]);
    assert.equal(runtimeTab.tab.extensionUi.toolsExpanded, false);
    assert.equal(runtimeTab.tab.extensionUi.title, "Extension Title");
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 40, "aboveEditor").join("\n"),
      /factory:38/,
    );
    assert.match(renderExtensionWidgets(runtimeTab.tab, 40, "belowEditor").join("\n"), /line one/);
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
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const entry = runtime.getExtensionManagerEntries("s1").find((item) => item.source === "inline");
    assert.ok(entry);
    assert.equal(entry.enabled, true);

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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension factory widgets render live state after requestRender", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-live-widget-"));
  let count = 0;
  let widgetTui: TUI | undefined;
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
    assert.match(
      stripAnsi(renderExtensionWidgets(runtimeTab.tab, 80, "aboveEditor").join("\n")),
      /Todos \(1\/5\)/,
    );
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
        setEditorComponent: () => undefined,
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

    await runtime.prompt("s1", "/reload-smoke");

    assert.equal(runtime.dispatchTerminalInput("s1", "reload-key")?.consume, true);
    assert.deepEqual(runtimeTab.tab.extensionUi.statuses, [{ key: "state", text: "reload" }]);
    assert.equal(runtimeTab.tab.extensionUi.workingMessage, "working:reload");
    assert.deepEqual(events, ["start:startup", "shutdown:reload", "start:reload", "after-reload"]);
    runtime.setExtensionUiHost(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    assert.ok(widget);
    assert.equal(widget?.lines.length, 3);
    assert.equal((widget?.lines[1] ?? "x").trim(), "");
    const rendered = renderExtensionWidgets(runtimeTab.tab, 40, "belowEditor");
    assert.equal(rendered.length, 3);
    assert.equal(stripAnsi(rendered[1] ?? "x").trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
