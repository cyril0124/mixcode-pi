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
  renderThinking,
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

test("runtime maps extension select, confirm, and input UI primitives into editor component", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-dialogs-"));
  const events: string[] = [];
  let abortController: AbortController | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("dialog-smoke", {
      description: "Dialog primitive smoke",
      handler: async (_args, ctx) => {
        const selected = await ctx.ui.select("Pick Target", ["alpha", "beta"]);
        events.push(`select:${selected ?? "none"}`);
        const confirmed = await ctx.ui.confirm("Confirm", "Proceed?");
        events.push(`confirm:${confirmed}`);
        const typed = await ctx.ui.input("Name", "Type name");
        events.push(`input:${typed ?? "none"}`);
      },
    });
    pi.registerCommand("dialog-abort", {
      description: "Abort dialog smoke",
      handler: async (_args, ctx) => {
        abortController = new AbortController();
        const selected = await ctx.ui.select("Abort Pick", ["one"], {
          signal: abortController.signal,
        });
        events.push(`abort:${selected ?? "none"}`);
      },
    });
    pi.registerCommand("dialog-timeout", {
      description: "Timeout dialog smoke",
      handler: async (_args, ctx) => {
        const selected = await ctx.ui.select("Timeout Pick", ["one"], { timeout: 1 });
        events.push(`timeout:${selected ?? "none"}`);
      },
    });
    pi.registerCommand("dialog-already-aborted", {
      description: "Already aborted dialog smoke",
      handler: async (_args, ctx) => {
        const controller = new AbortController();
        controller.abort();
        const selected = await ctx.ui.select("Already Abort Pick", ["one"], {
          signal: controller.signal,
        });
        events.push(`already-aborted:${selected ?? "none"}`);
      },
    });
    pi.registerCommand("dialog-input-title", {
      description: "Input title fallback smoke",
      handler: async (_args, ctx) => {
        const typed = await ctx.ui.input("Fallback Name");
        events.push(`input-title:${typed ?? "none"}`);
      },
    });
  };

  // Mock editor host that captures setEditorComponent calls
  type EditorComponentLike = { render(w: number): string[]; handleInput(d: string): void };
  let activeEditorComponent: EditorComponentLike | undefined;
  const mockEditorHost = {
    tui: {} as any,
    editor: {
      getText: () => "",
      getExpandedText: () => "",
      setText: () => undefined,
      pasteToEditor: () => undefined,
      setEditorComponent: (factory: (() => EditorComponentLike) | undefined) => {
        activeEditorComponent = factory?.();
      },
      getEditorComponent: () => undefined,
    },
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost(mockEditorHost as any);
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    // Test select dialog
    const dialogTask = runtime.prompt("s1", "/dialog-smoke");
    await waitFor(() => activeEditorComponent !== undefined);
    // Verify render shows options
    const rendered = activeEditorComponent!.render(80);
    const plain = rendered.map(stripAnsi).join("\n");
    assert.match(plain, /Pick Target/);
    assert.match(plain, /alpha/);
    assert.match(plain, /beta/);
    // Move down to "beta" and press enter
    activeEditorComponent!.handleInput("\x1b[B"); // down arrow
    activeEditorComponent!.handleInput("\r"); // enter
    await waitFor(() => activeEditorComponent !== undefined && events.length >= 1);

    // Confirm dialog: select "Yes" (first option, already highlighted)
    await waitFor(() => {
      if (!activeEditorComponent) return false;
      const r = activeEditorComponent.render(80).map(stripAnsi).join("\n");
      return r.includes("Yes");
    });
    activeEditorComponent!.handleInput("\r"); // enter selects "Yes"
    await waitFor(() => events.length >= 2);

    // Input dialog: type "MixCode" and press enter
    await waitFor(() => {
      if (!activeEditorComponent) return false;
      const r = activeEditorComponent.render(80).map(stripAnsi).join("\n");
      return r.includes("submit");
    });
    for (const ch of "MixCode") activeEditorComponent!.handleInput(ch);
    activeEditorComponent!.handleInput("\r"); // enter
    await dialogTask;
    assert.deepEqual(events, ["select:beta", "confirm:true", "input:MixCode"]);

    // Test abort
    const abortTask = runtime.prompt("s1", "/dialog-abort");
    await waitFor(() => activeEditorComponent !== undefined && events.length === 3);
    await waitFor(() => {
      if (!activeEditorComponent) return false;
      const r = activeEditorComponent.render(80).map(stripAnsi).join("\n");
      return r.includes("Abort Pick");
    });
    abortController?.abort();
    await abortTask;
    assert.equal(events.at(-1), "abort:none");

    // Test timeout
    await runtime.prompt("s1", "/dialog-timeout");
    assert.equal(events.at(-1), "timeout:none");

    // Test already-aborted
    await runtime.prompt("s1", "/dialog-already-aborted");
    assert.equal(events.at(-1), "already-aborted:none");

    // Test input with title fallback
    const inputTitleTask = runtime.prompt("s1", "/dialog-input-title");
    await waitFor(() => {
      if (!activeEditorComponent) return false;
      const r = activeEditorComponent.render(80).map(stripAnsi).join("\n");
      return r.includes("Fallback Name");
    });
    for (const ch of "Named") activeEditorComponent!.handleInput(ch);
    activeEditorComponent!.handleInput("\r");
    await inputTitleTask;
    assert.equal(events.at(-1), "input-title:Named");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime resolves pending extension dialogs when closing a tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-dialog-shutdown-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("wait-dialog", {
      description: "Dialog shutdown smoke",
      handler: async (_args, ctx) => {
        const selected = await ctx.ui.select("Wait", ["one"]);
        events.push(`closed:${selected ?? "none"}`);
      },
    });
  };

  // Mock editor host
  const mockEditorHost = {
    tui: {} as any,
    editor: {
      getText: () => "",
      getExpandedText: () => "",
      setText: () => undefined,
      pasteToEditor: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
    },
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost(mockEditorHost as any);
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const prompt = runtime.prompt("s1", "/wait-dialog");
    // Wait for the dialog to be installed (pending user interaction)
    await waitForRuntime(
      () => runtime.getTab("s1")?.tab.extensionUi.pendingUserInteractions.length === 1,
    );
    await runtime.deleteTab("s1");
    await prompt;

    assert.deepEqual(events, ["closed:none"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime renders pi custom messages with renderer, fallback, errors, and restored history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-custom-message-"));
  let statefulRenderCreations = 0;
  let statefulRenderDisposals = 0;
  let replaceRenderCreations = 0;
  let replaceRenderDisposals = 0;
  let replaceRenderGeneration = 0;
  const extension: ExtensionFactory = (pi) => {
    pi.registerMessageRenderer(
      "rendered-note",
      (message) => new Text(`component:${message.content}`, 0, 0),
    );
    pi.registerMessageRenderer("stateful-note", (message) => {
      statefulRenderCreations++;
      return {
        invalidate: () => undefined,
        render: () => [`stateful:${message.content}:${statefulRenderCreations}`],
        dispose: () => {
          statefulRenderDisposals++;
        },
      };
    });
    pi.registerMessageRenderer("undefined-note", () => undefined);
    pi.registerMessageRenderer("broken-note", () => {
      throw new Error("broken renderer");
    });
    pi.registerMessageRenderer("replace-note", (message) => {
      replaceRenderCreations++;
      const generation = replaceRenderGeneration++;
      return {
        invalidate: () => undefined,
        render: () => [`replace:${message.content}:${generation}`],
        dispose: () => {
          replaceRenderDisposals++;
        },
      };
    });
    pi.registerMessageRenderer("broken-after-note", () => {
      throw "broken string renderer";
    });
    pi.registerCommand("custom-smoke", {
      description: "Custom message renderer smoke",
      handler: async () => {
        pi.sendMessage({ customType: "rendered-note", content: "shown", display: true });
        pi.sendMessage({ customType: "stateful-note", content: "kept", display: true });
        pi.sendMessage({ customType: "undefined-note", content: "fallback shown", display: true });
        pi.sendMessage({
          customType: "broken-note",
          content: "raw hidden by error",
          display: true,
        });
        pi.sendMessage({ customType: "replace-note", content: "replace me", display: true });
        pi.sendMessage({ customType: "", content: "", display: true });
        pi.sendMessage({ customType: "broken-after-note", content: "broken later", display: true });
        pi.sendMessage({ customType: "hidden-note", content: "must not display", display: false });
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

    await runtime.prompt("s1", "restore anchor");
    await runtime.prompt("s1", "/custom-smoke");
    assert.equal(runtimeTab.chat.filter((line) => line.role === "extension").length, 7);
    const surface = renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n");
    assert.match(surface, /component:shown/);
    assert.match(surface, /stateful:kept:1/);
    assert.match(surface, /undefined-note/);
    assert.match(surface, /fallback shown/);
    assert.match(surface, /extension renderer error \(broken-note\): broken renderer/);
    assert.match(surface, /replace:replace me:0/);
    assert.equal(
      runtimeTab.chat.some(
        (line) => line.role === "extension" && line.customType === "" && line.title === "extension",
      ),
      true,
    );
    assert.match(surface, /\bextension\b/);
    assert.match(surface, /extension renderer error \(broken-after-note\): broken string renderer/);
    assert.doesNotMatch(surface, /must not display/);
    renderAgentSurface(runtimeTab.tab, runtimeTab, 100);
    assert.equal(statefulRenderCreations, 1);
    assert.equal(statefulRenderDisposals, 0);
    const replaceLine = runtimeTab.chat.find(
      (line) => line.role === "extension" && line.customType === "replace-note",
    );
    assert.ok(replaceLine?.renderExtension);
    replaceLine.extensionRendererExpanded = true;
    assert.match(replaceLine.renderExtension(100).join("\n"), /replace:replace me:\d+/);
    assert.equal(replaceRenderCreations >= 2, true);
    assert.equal(replaceRenderDisposals >= 1, true);
    replaceLine.extensionRendererLastComponent = {
      render: () => ["stale"],
      invalidate: () => undefined,
      dispose: () => {
        replaceRenderDisposals++;
      },
    };
    replaceLine.extensionRendererExpanded = true;
    assert.match(replaceLine.renderExtension(100).join("\n"), /replace:replace me:/);
    assert.equal(replaceRenderDisposals >= 2, true);

    const reopened = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const reopenedTab = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const reopenedSurface = renderAgentSurface(reopenedTab.tab, reopenedTab, 100).join("\n");
    assert.match(reopenedSurface, /component:shown/);
    assert.match(reopenedSurface, /fallback shown/);
    assert.match(reopenedSurface, /extension renderer error \(broken-note\): broken renderer/);
    assert.doesNotMatch(reopenedSurface, /must not display/);
    await runtime.closeTab("s1");
    assert.equal(statefulRenderDisposals, 1);
    await reopened.closeTab("s1");
    assert.equal(statefulRenderDisposals, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
