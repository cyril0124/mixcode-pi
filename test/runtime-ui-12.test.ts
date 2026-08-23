import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  getMarkdownTheme,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Markdown, TuiMainScreen, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeRuntime,
  createInitialState,
  createTab,
  createMixCodeTui,
  renderTabBar,
} from "./helpers/mixcode.js";

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

test("runtime initializes pi theme before rendering extension custom markdown overlays", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-markdown-"));
  const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
  const previousTheme = (globalThis as Record<symbol, unknown>)[themeKey];
  delete (globalThis as Record<symbol, unknown>)[themeKey];
  const terminal = silentTerminal();
  const tui = new TuiMainScreen(terminal);
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps enter as the extension select confirmation key", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-enter-"));
  const terminal = silentTerminal();
  const tui = new TuiMainScreen(terminal);
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime renders custom overlays with their scoped terminal row budget", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-rows-"));
  const terminal = silentTerminal();
  const tui = new TuiMainScreen(terminal);
  let overlayComponent: Component | undefined;
  let overlayOptions: OverlayOptions | undefined;
  const originalShowOverlay = tui.showOverlay.bind(tui);
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-rows", {
      description: "Custom overlay row budget smoke",
      handler: async (_args, ctx) => {
        await ctx.ui.custom<string>(
          (hostTui, _theme, _keybindings, done) => ({
            render: () =>
              Array.from({ length: hostTui.terminal.rows }, (_, index) =>
                index === hostTui.terminal.rows - 1 ? "shortcut footer" : `body ${index}`,
              ),
            handleInput: () => done("closed"),
            invalidate: () => undefined,
          }),
          {
            overlay: true,
            overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 },
          },
        );
      },
    });
  };

  tui.showOverlay = ((component: Component, options?: OverlayOptions) => {
    overlayComponent = component;
    overlayOptions = options;
    return originalShowOverlay(component, options);
  }) as typeof tui.showOverlay;

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost({ tui, topReservedRows: () => 5 });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const task = runtime.prompt("s1", "/custom-rows");
    await waitFor(() => !!overlayComponent && !!overlayOptions);
    const margin = overlayOptions!.margin as {
      top?: number;
      bottom?: number;
    };
    const visibleRows = terminal.rows - (margin.top ?? 0) - (margin.bottom ?? 0);
    const visible = overlayComponent!.render(80).slice(0, visibleRows).join("\n");
    assert.match(visible, /shortcut footer/);
    overlayComponent!.handleInput?.("q");
    await task;
  } finally {
    tui.stop();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime scopes extension custom overlays to the active tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-tab-scope-"));
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
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      assert.equal(overlayOptions?.visible?.(100, 24), true);

      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\t");
      assert.equal(state.activeTabId, "s2");
      assert.equal(overlayOptions?.visible?.(100, 24), false);
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\r");
      assert.deepEqual(events, []);

      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\x1b[Z");
      assert.equal(state.activeTabId, "s1");
      assert.equal(overlayOptions?.visible?.(100, 24), true);
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\r");
      await task;
      assert.deepEqual(events, ["result:selected"]);
      assert.equal(runtime.hasExtensionCustomOverlay("s1"), false);
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime focuses extension custom overlay triggered while its tab was inactive", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-inactive-focus-"));
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
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput(data);
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
    } finally {
      // Settle the pending ui.custom promise if the assertions above failed.
      runtime.setExtensionUiHost(undefined);
      await task?.catch(() => undefined);
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps pi extension custom non-overlay into the live editor slot", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-editor-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("custom-editor", {
      description: "Custom editor smoke",
      handler: async (_args, ctx) => {
        const result = await ctx.ui.custom<string>((hostTui, theme, keybindings, done) => {
          events.push(`host:${hostTui !== undefined}`);
          // Assert the handed-over manager resolves MixCode's escape routing,
          // not pi-tui's full default key list (upstream may add keys).
          events.push(`kb:${keybindings.getKeys("tui.select.cancel").includes("escape")}`);
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
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      assert.deepEqual(events.slice(0, 2), ["host:true", "kb:true"]);

      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("x");
      await waitFor(() => /editor updated 80/.test(stripAnsi(tui.render(80).join("\n"))));
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\r");
      await promptTask;

      assert.equal(runtime.hasExtensionCustomOverlay("s1"), false);
      assert.ok(events.includes("dispose"));
      assert.ok(events.includes("result:updated"));
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      const restoredEditor = stripAnsi(tui.render(80).join("\n"));
      assert.match(restoredEditor, /Send message to Agent-01\.\.\./);
      assert.doesNotMatch(restoredEditor, /editor updated/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime scopes extension custom non-overlay editors to their owning tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-editor-scope-"));
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
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);

      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\t");
      assert.equal(state.activeTabId, "s2");
      assert.doesNotMatch(stripAnsi(tui.render(80).join("\n")), /scoped editor/);
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\r");
      assert.deepEqual(events, []);

      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\x1b[Z");
      assert.equal(state.activeTabId, "s1");
      assert.match(stripAnsi(tui.render(80).join("\n")), /scoped editor tab-one 80/);
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("x");
      await waitFor(() => /scoped editor updated 80/.test(stripAnsi(tui.render(80).join("\n"))));
      (tui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\r");
      await promptTask;

      assert.deepEqual(events, ["dispose", "result:updated"]);
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
      assert.doesNotMatch(stripAnsi(tui.render(80).join("\n")), /scoped editor/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime tracks concurrent extension custom interactions independently", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-custom-concurrent-"));
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
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);

      overlayComponents[0]!.handleInput?.("\r");
      await waitFor(() => events.includes("first:first"));
      assert.match(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);

      overlayComponents[1]!.handleInput?.("\r");
      await firstTask;
      await secondTask;
      assert.deepEqual(events, ["first:first", "second:second"]);
      assert.doesNotMatch(stripAnsi(renderTabBar(state, 80).join("\n")), /\? Agent-01/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
