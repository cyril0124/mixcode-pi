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

test("runtime renders extension tool results with registered tool renderers", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-tool-renderer-"));
  const extension: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "rendered_tool",
      label: "Rendered",
      description: "Tool with custom renderResult.",
      parameters: Type.Object({ subject: Type.String() }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: `raw ${params.subject}` }],
        details: { subject: params.subject },
      }),
      renderCall: (args, _theme, context) =>
        new Text(
          `call ${args.subject} started=${context.executionStarted} complete=${context.argsComplete}`,
          0,
          0,
        ),
      renderResult: (result, options, _theme, context) => {
        const details = result.details as { subject?: string } | undefined;
        return new Text(
          `rendered ${details?.subject} partial=${options.isPartial} error=${context.isError}`,
          0,
          0,
        );
      },
    });
    pi.registerTool({
      name: "empty_render_tool",
      label: "Empty Render",
      description: "Tool with undefined renderers.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "empty raw" }], details: {} }),
      renderCall: () => undefined,
      renderResult: () => undefined,
    });
    pi.registerTool({
      name: "broken_render_tool",
      label: "Broken Render",
      description: "Tool with failing renderResult.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "raw broken" }], details: {} }),
      renderResult: () => {
        throw new Error("tool renderer failed");
      },
    });
    pi.registerTool({
      name: "broken_string_render_tool",
      label: "Broken String Render",
      description: "Tool with non-Error render failures.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "raw broken string" }],
        details: {},
      }),
      renderCall: () => {
        throw "call string failure";
      },
      renderResult: () => {
        throw "result string failure";
      },
    });
    pi.registerTool({
      name: "broken_call_tool",
      label: "Broken Call",
      description: "Tool with failing renderCall.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "raw broken call" }], details: {} }),
      renderCall: () => {
        throw new Error("tool call renderer failed");
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
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "rendered-1",
      toolName: "rendered_tool",
      args: { subject: "alpha" },
    });
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /call alpha started=true complete=false/,
    );
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_update",
      toolCallId: "rendered-1",
      toolName: "rendered_tool",
      args: { subject: "alpha" },
      partialResult: {
        content: [{ type: "text", text: "partial raw" }],
        details: { subject: "alpha" },
      },
    });
    const partialSurface = renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n");
    assert.match(partialSurface, /call alpha started=true complete=false/);
    assert.match(partialSurface, /rendered alpha partial=true error=false/);
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "rendered-1",
      toolName: "rendered_tool",
      result: { content: [{ type: "text", text: "raw alpha" }], details: { subject: "alpha" } },
      isError: false,
    });
    const surface = renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n");
    assert.match(surface, /call alpha started=true complete=true/);
    assert.match(surface, /rendered alpha partial=false error=false/);
    assert.doesNotMatch(surface, /raw alpha/);

    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "rendered-2",
      toolName: "rendered_tool",
      args: { subject: "beta" },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "rendered-2",
      toolName: "rendered_tool",
      result: { content: [{ type: "text", text: "raw beta" }], details: { subject: "beta" } },
      isError: true,
    });
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /rendered beta partial=false error=true/,
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "broken-1",
      toolName: "broken_render_tool",
      result: { content: [{ type: "text", text: "raw broken" }], details: {} },
      isError: false,
    });
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /tool renderer error \(broken_render_tool\): tool renderer failed/,
    );
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "broken-call-1",
      toolName: "broken_call_tool",
      args: {},
    });
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /tool call renderer error \(broken_call_tool\): tool call renderer failed/,
    );
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "empty-call-1",
      toolName: "empty_render_tool",
      result: { content: [{ type: "text", text: "empty raw" }], details: {} },
      isError: false,
    });
    assert.match(renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"), /empty raw/);
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "broken-string-1",
      toolName: "broken_string_render_tool",
      args: {},
    });
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /tool call renderer error \(broken_string_render_tool\): call string failure/,
    );
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "broken-string-2",
      toolName: "broken_string_render_tool",
      result: { content: [{ type: "text", text: "raw broken string" }], details: {} },
      isError: false,
    });
    assert.match(
      renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"),
      /tool renderer error \(broken_string_render_tool\): result string failure/,
    );

    runtimeTab.session.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "restore-rendered",
          name: "rendered_tool",
          arguments: { subject: "gamma" },
        },
      ],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "toolResult",
      toolCallId: "restore-rendered",
      toolName: "rendered_tool",
      content: [{ type: "text", text: "raw gamma" }],
      details: { subject: "gamma" },
      isError: false,
      timestamp: Date.now(),
    });
    const reopened = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const restored = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.match(
      renderAgentSurface(restored.tab, restored, 100).join("\n"),
      /rendered gamma partial=false error=false/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime renders compact skill read calls with configured expand key", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-skill-read-key-"));
  const skillDir = path.join(dir, "find-skills");
  await fsPromises.mkdir(skillDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: find-skills\ndescription: Find skills\n---\n# Find Skills\n",
    "utf8",
  );
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "read-skill",
      toolName: "read",
      args: { path: path.join(skillDir, "SKILL.md") },
    });
    const surface = stripAnsi(renderAgentSurface(runtimeTab.tab, runtimeTab, 100).join("\n"));
    // Pi's read tool renders SKILL.md reads as a compact [skill] block whose
    // expand hint is built from the configured app.tools.expand key.
    assert.match(surface, /\[skill\] find-skills/);
    assert.match(surface, /\(ctrl\+o to expand\)/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
