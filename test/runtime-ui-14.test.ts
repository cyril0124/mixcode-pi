import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import type {
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type AutocompleteProvider, type Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeCompletionProvider,
  MixCodeRuntime,
  createInitialState,
  createTab,
  createMixCodeTui,
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

test("runtime keeps the previous editor component when extension editor factory fails", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-editor-component-error-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("editor-component-error", {
      description: "Editor component failure smoke",
      handler: async (_args, ctx) => {
        const factory = () => {
          let text = "";
          return {
            render: () => [`stable:${text}`],
            invalidate: () => undefined,
            getText: () => text,
            setText: (next: string) => {
              text = next;
            },
            handleInput: (data: string) => {
              text += data;
            },
          };
        };
        ctx.ui.setEditorText("stable");
        ctx.ui.setEditorComponent(factory);
        events.push(`before:${ctx.ui.getEditorComponent() === factory}:${ctx.ui.getEditorText()}`);
        try {
          ctx.ui.setEditorComponent(() => {
            throw new Error("broken editor factory");
          });
        } catch (error) {
          events.push(`error:${error instanceof Error ? error.message : String(error)}`);
        }
        events.push(`after:${ctx.ui.getEditorComponent() === factory}:${ctx.ui.getEditorText()}`);
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
      await runtime.prompt("s1", "/editor-component-error");
      assert.deepEqual(events, [
        "before:true:stable",
        "error:broken editor factory",
        "after:true:stable",
      ]);
      assert.match(tui.render(80).join("\n"), /stable:stable/);
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps pi extension multiline editor primitive into an in-place editor swap", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-multiline-editor-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("edit-smoke", {
      description: "Multiline editor primitive smoke",
      handler: async (_args, ctx) => {
        const edited = await ctx.ui.editor("Edit Note", "prefill");
        events.push(`edited:${edited ?? "none"}`);
      },
    });
    pi.registerCommand("edit-cancel", {
      description: "Multiline editor cancel smoke",
      handler: async (_args, ctx) => {
        const edited = await ctx.ui.editor("Cancel Note", "cancel me");
        events.push(`cancel:${edited ?? "none"}`);
      },
    });
  };

  // Mock editor host: matching Pi agent behavior, ctx.ui.editor() swaps the
  // real input editor component in place (EditorSlot) rather than opening a
  // floating overlay. This mirrors the mockEditorHost pattern used for
  // ctx.ui.select/confirm/input primitive tests.
  type EditorComponentLike = { render(w: number): string[]; handleInput?(d: string): void };
  let activeEditorComponent: EditorComponentLike | undefined;
  let restoredToPrevious = false;
  const terminal = silentTerminal();
  const tui = new TuiMainScreen(terminal);
  const mockEditorHost = {
    tui,
    editor: {
      getText: () => "",
      getExpandedText: () => "",
      setText: () => undefined,
      pasteToEditor: () => undefined,
      setEditorComponent: (factory: (() => EditorComponentLike) | undefined) => {
        activeEditorComponent = factory?.();
        if (!factory) restoredToPrevious = true;
      },
      getEditorComponent: () => undefined,
      getEmbeddedTerminalRows: () => undefined,
    },
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost(mockEditorHost as any);
    const tab = createTab(1, "s1", process.cwd());
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const editTask = runtime.prompt("s1", "/edit-smoke");
    await waitFor(() => !!activeEditorComponent);
    const editComponent = activeEditorComponent!;
    assert.match(stripAnsi(editComponent.render(100).join("\n")), /Edit Note/);
    editComponent.handleInput?.(" updated");
    editComponent.handleInput?.("\r");
    await editTask;
    assert.equal(restoredToPrevious, true);
    assert.equal(events.at(-1), "edited:prefill updated");

    restoredToPrevious = false;
    const cancelTask = runtime.prompt("s1", "/edit-cancel");
    await waitFor(() => !!activeEditorComponent);
    const cancelComponent = activeEditorComponent!;
    assert.match(stripAnsi(cancelComponent.render(100).join("\n")), /Cancel Note/);
    cancelComponent.handleInput?.("\x1b");
    cancelComponent.handleInput?.("\r");
    await cancelTask;
    assert.equal(restoredToPrevious, true);
    assert.equal(events.at(-1), "cancel:none");
  } finally {
    tui.stop();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension multiline editor requires a live TUI host", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-editor-no-host-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("edit-no-host", {
      description: "Editor host boundary",
      handler: async (_args, ctx) => {
        try {
          await ctx.ui.editor("Missing Host");
        } catch (error) {
          events.push(error instanceof Error ? error.message : String(error));
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
    await runtime.prompt("s1", "/edit-no-host");
    assert.match(events[0] ?? "", /requires an active MixCode TUI host: editor/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime applies pi extension autocomplete providers on top of MixCode completions", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-autocomplete-"));
  const seen: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.addAutocompleteProvider((current) => ({
        getSuggestions: async (lines, cursorLine, cursorCol, options) => {
          const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
          if (before.endsWith("#a"))
            return {
              prefix: "#a",
              items: [{ value: "#alpha", label: "alpha", description: "extension" }],
            };
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
          current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
        shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false,
      }));
      ctx.ui.addAutocompleteProvider((current) => ({
        getSuggestions: async (lines, cursorLine, cursorCol, options) => {
          seen.push(`wrapper:${(lines[cursorLine] ?? "").slice(0, cursorCol)}`);
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
          current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
        shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false,
      }));
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const base: AutocompleteProvider = new MixCodeCompletionProvider({
      skills: ["review"],
    });
    const provider = runtime.applyExtensionAutocompleteProviders("s1", base);
    assert.equal(runtime.applyExtensionAutocompleteProviders("s1", base), provider);
    const signal = new AbortController().signal;

    const extensionSuggestions = await provider.getSuggestions(["try #a"], 0, 6, { signal });
    assert.equal(extensionSuggestions?.prefix, "#a");
    assert.equal(extensionSuggestions?.items[0]?.value, "#alpha");
    assert.deepEqual(seen, ["wrapper:try #a"]);

    const slashSuggestions = await provider.getSuggestions(["/th"], 0, 3, { signal });
    assert.equal(slashSuggestions?.items[0]?.value, "thinking");
    assert.deepEqual(seen, ["wrapper:try #a", "wrapper:/th"]);
    assert.equal(provider.shouldTriggerFileCompletion?.(["see @src"], 0, 8), true);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime refreshes live editor autocomplete providers registered after cache warmup", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-autocomplete-live-"));
  let setProviderCalls = 0;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("add-provider", {
      description: "Add live provider",
      handler: async (_args, ctx) => {
        ctx.ui.addAutocompleteProvider((current) => ({
          getSuggestions: async (lines, cursorLine, cursorCol, options) => {
            const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
            if (before.endsWith("%"))
              return { prefix: "%", items: [{ value: "%done", label: "done" }] };
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          },
          applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
            current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
          shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
            current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false,
        }));
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
    const base: AutocompleteProvider = new MixCodeCompletionProvider({ skills: [] });
    runtime.setExtensionUiHost({
      tui: new TuiMainScreen(silentTerminal()),
      editor: {
        getText: () => "",
        setText: () => undefined,
        pasteToEditor: () => undefined,
        setAutocompleteProvider: () => {
          setProviderCalls++;
        },
      },
    });
    runtime.applyExtensionAutocompleteProviders("s1", base); // warm the cache
    await runtime.prompt("s1", "/add-provider");
    assert.equal(setProviderCalls, 1);
    const provider = runtime.applyExtensionAutocompleteProviders("s1", base);
    const suggestions = await provider.getSuggestions(["%"], 0, 1, {
      signal: new AbortController().signal,
    });
    assert.equal(suggestions?.items[0]?.value, "%done");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
