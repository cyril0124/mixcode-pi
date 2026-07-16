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

test("runtime lets Pi resource loader discover project system prompt before MixCode fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-system-resource-"));
  const repo = join(dir, "repo");
  try {
    await mkdir(join(repo, ".pi"), { recursive: true });
    await writeFile(join(repo, ".pi", "SYSTEM.md"), "Project system prompt", "utf8");
    await writeFile(join(repo, ".pi", "APPEND_SYSTEM.md"), "Append prompt", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, "sessions") });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", repo), {
      systemPrompt: "Fallback prompt",
      thinkingLevel: "medium",
      workdir: repo,
    });

    assert.match(runtimeTab.agent.state.systemPrompt, /Project system prompt/);
    assert.match(runtimeTab.agent.state.systemPrompt, /Append prompt/);
    assert.doesNotMatch(runtimeTab.agent.state.systemPrompt, /Fallback prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime refresh syncs tab status from pi agent state", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd(), { status: "done" });
  const explicit: Model<string> = {
    ...MIXCODE_FAUX_MODEL,
    id: "refresh-model",
    contextWindow: 1234,
  };
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "high",
    workdir: process.cwd(),
    model: explicit,
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "usage" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 7,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });

  const refreshed = runtime.refreshAllTabStatuses();
  assert.equal(refreshed[0], tab);
  assert.equal(tab.status, "done");
  assert.equal(tab.model.modelId, "refresh-model");
  assert.equal(tab.model.contextWindow, 1234);
  assert.equal(tab.contextLimit, 1234);
  assert.equal(tab.thinkingLevel, "high");
  assert.equal(tab.currentContextTokens, 12);
  tab.status = "running";
  runtime.refreshTabStatus("s1");
  assert.equal(tab.status, "idle");
  await assert.rejects(async () => runtime.refreshTabStatus("missing"), /Unknown tab session/);
});

test("runtime tab reflects Pi thinking clamp after creation", async () => {
  const runtime = new MixCodeRuntime();
  const model: Model<string> = {
    ...MIXCODE_FAUX_MODEL,
    id: "no-reasoning-model",
    reasoning: false,
  };
  const tab = createTab(1, "s1", process.cwd(), { thinkingLevel: "max" });

  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "",
    thinkingLevel: "max",
    workdir: process.cwd(),
    model,
  });

  assert.equal(runtimeTab.agentSession.thinkingLevel, "off");
  assert.equal(tab.thinkingLevel, "off");
});

test("runtime thinking update delegates to Pi agent session", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd(), { thinkingLevel: "high" });
  const model: Model<string> = {
    ...MIXCODE_FAUX_MODEL,
    id: "max-model",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "",
    thinkingLevel: "high",
    workdir: process.cwd(),
    model,
  });

  const effective = runtime.updateTabThinkingLevel("s1", "max");

  assert.equal(effective, "max");
  assert.equal(runtimeTab.agent.state.thinkingLevel, "max");
  assert.equal(runtimeTab.agentSession.thinkingLevel, "max");
  assert.equal(tab.thinkingLevel, "max");
});

test("runtime covers idle, running, and error refresh branches", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd(), { status: "running" });
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyAgent = runtimeTab.agent as unknown as {
    _state: { isStreaming: boolean; errorMessage?: string };
  };

  runtime.refreshTabStatus("s1");
  assert.equal(tab.status, "idle");
  assert.equal(tab.currentContextTokens, undefined);
  assert.match(
    runtimeTab.agent.state.systemPrompt,
    /^You are an expert coding assistant operating inside pi/,
  );

  Object.defineProperty(runtimeTab.agentSession, "isStreaming", { configurable: true, value: true });
  runtime.refreshTabStatus("s1");
  assert.equal(tab.status, "running");

  anyAgent._state.isStreaming = true;
  Object.defineProperty(runtimeTab.agentSession, "isStreaming", { configurable: true, value: false });
  runtime.refreshTabStatus("s1");
  assert.equal(tab.status, "idle");

  anyAgent._state.errorMessage = "provider failed";
  runtime.refreshTabStatus("s1");
  assert.equal(tab.status, "error");

  anyAgent._state.errorMessage = undefined;
  anyAgent._state.isStreaming = false;
});
