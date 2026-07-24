import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  configureOpenTabsPath,
  createInitialState,
  createTab,
  createMixCodeTui,
  handleSubmittedInput,
  handleMixCodeKeyInput,
  openTabsFile,
  readOpenTabs,
  renderChat,
  UUIDV7_SESSION_ID_PATTERN,
  type MixCodeRuntime as RuntimeType,
} from "../src/index.js";
import { hydrateTabPromptHistory } from "../src/ui/app-runtime.js";

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

test("createMixCodeTui hydrates editor history per tab from restored runtime user messages", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  const tab2 = createTab(2, "s2", "/repo");
  state.tabs.push(tab, tab2);
  state.activeTabId = "s1";
  const historyReady = new Set<string>();
  let extensionConsumesUp = true;
  const runtime = {
    onChange: () => () => undefined,
    getTab: (sessionId: string) =>
      historyReady.has(sessionId)
        ? {
            tab: sessionId === "s1" ? tab : tab2,
            chat: [],
          }
        : undefined,
    getPromptHistory: (sessionId: string) => {
      if (!historyReady.has(sessionId)) return [];
      return sessionId === "s1" ? ["older prompt", "newer prompt"] : ["tab two prompt"];
    },
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: unknown) => base,
    dispatchTerminalInput: (_sessionId: string, data: string) =>
      extensionConsumesUp && data === "\x1b[A" ? { consume: true } : undefined,
    setExtensionUiHost: () => undefined,
  } as unknown as RuntimeType;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  try {
    const layout = (
      tui as unknown as {
        children: Array<{ editor: { getText: () => string; handleInput: (data: string) => void } }>;
      }
    ).children[0]!;
    const handleTuiInput = (data: string) =>
      (tui as unknown as { handleInput: (data: string) => void }).handleInput(data);
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "");
    historyReady.add("s1");
    historyReady.add("s2");
    hydrateTabPromptHistory(state, runtime);
    assert.deepEqual(tab.promptHistory, ["newer prompt", "older prompt"]);
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "");
    extensionConsumesUp = false;
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "newer prompt");
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "older prompt");
    handleTuiInput("\x1b[B");
    assert.equal(layout.editor.getText(), "newer prompt");
    handleTuiInput("\x1b[B");
    assert.equal(layout.editor.getText(), "");
    handleTuiInput("\t");
    assert.equal(state.activeTabId, "s2");
    handleTuiInput("\x1b[A");
    assert.equal(layout.editor.getText(), "tab two prompt");
  } finally {
    tui.stop();
  }
});

test("submitted input handles prompt, shell, local commands, clear, and missing active tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-submit-"));
  const openTabsPath = openTabsFile(dir);
  configureOpenTabsPath(openTabsPath);
  const state = createInitialState(dir);
  const tab = createTab(1, "s1", dir);
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const prompts: string[] = [];
  const shellCommands: Array<{ command: string; excludeFromContext: boolean | undefined }> = [];
  const cleared: string[] = [];
  const closed: string[] = [];
  const created: string[] = [];
  const forked: string[] = [];
  const runtime = {
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
    executeShellCommand: async (
      _sessionId: string,
      command: string,
      options?: { excludeFromContext?: boolean },
    ) => {
      shellCommands.push({ command, excludeFromContext: options?.excludeFromContext });
    },
    appendSystemMessage: (_sessionId: string, text: string) => {
      tab.previewMessages.push({ role: "system", text });
      tab.previewIndex = tab.previewMessages.length - 1;
    },
    getTab: () => ({ chat: [{ role: "user", text: "old" }] }),
    clearTab: async (sessionId: string) => {
      cleared.push(sessionId);
      tab.sessionId = "cleared";
      return { tab };
    },
    createTab: async (createdTab: { sessionId: string }) => {
      created.push(createdTab.sessionId);
    },
    forkSession: async (_sourceSessionId: string, newSessionId: string) => {
      forked.push(newSessionId);
    },
    closeTab: async (sessionId: string) => {
      closed.push(sessionId);
    },
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
    resolveModel: (provider: string, modelId: string) => ({
      ...MIXCODE_FAUX_MODEL,
      provider,
      id: modelId,
    }),
    updateTabModel: (_sessionId: string, model: Model<any>) => {
      tab.model = {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      };
      tab.contextLimit = model.contextWindow;
    },
    getExtensionCommands: () => [{ name: "run", description: "Run extension command" }],
  } as unknown as RuntimeType;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
  };
  try {
    await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "description: review",
      "utf8",
    );
    await writeFile(join(dir, "AGENTS.md"), "Follow repo rules", "utf8");
    await handleSubmittedInput(state, runtime, "hello $review @src/index.ts", tui);
    await handleSubmittedInput(state, runtime, "!pwd", tui);
    await handleSubmittedInput(state, runtime, "/clear", tui);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handleSubmittedInput(state, runtime, "/thinking high", tui);
    const workdirTarget = join(dir, "work");
    await mkdir(workdirTarget, { recursive: true });
    await handleSubmittedInput(state, runtime, `/workdir ${workdirTarget}`, tui);
    const { setTheme } = await import("../src/ui/themes.js");
    setTheme(state, "tokyo-night");
    await handleSubmittedInput(state, runtime, "/models faux-1", tui);
    await handleSubmittedInput(state, runtime, "/rename Renamed", tui);
    await handleSubmittedInput(state, runtime, "/fork forked", tui);
    const forkedSessionId = state.activeTabId;
    assert.match(forkedSessionId, UUIDV7_SESSION_ID_PATTERN);
    assert.notEqual(forkedSessionId, "forked");
    assert.equal(readOpenTabs(openTabsPath).includes(forkedSessionId), true);
    assert.deepEqual(
      state.tabs.map((item) => item.index),
      [1, 2],
    );
    await handleSubmittedInput(state, runtime, "/delete-session", tui);
    handleMixCodeKeyInput(state, "y", tui, undefined, runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handleSubmittedInput(state, runtime, "/new-session s2", tui);
    const newSessionId = state.activeTabId;
    assert.match(newSessionId, UUIDV7_SESSION_ID_PATTERN);
    assert.notEqual(newSessionId, "s2");
    await handleSubmittedInput(state, runtime, "/close-session", tui);
    handleMixCodeKeyInput(state, "y", tui, undefined, runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    setTheme(state, "mixcode-dark");
    await handleSubmittedInput(state, runtime, "/help", tui);
    await handleSubmittedInput(state, runtime, "/run worker task", tui);
    assert.equal(prompts[0], "hello $review @src/index.ts");
    assert.deepEqual(prompts.slice(1), ["/run worker task"]);
    assert.deepEqual(shellCommands, [{ command: "pwd", excludeFromContext: false }]);
    assert.deepEqual(cleared, ["s1"]);
    assert.deepEqual(closed, [newSessionId]);
    assert.deepEqual(created, [forkedSessionId, newSessionId]);
    assert.deepEqual(forked, [forkedSessionId]);
    assert.equal(state.activeTabId, "cleared");
    assert.equal(tab.thinkingLevel, "high");
    assert.equal(tab.workdir, workdirTarget);
    assert.equal(tab.title, "Renamed");
    assert.equal(tab.model.modelId, "faux-1");
    assert.equal(state.theme, "mixcode-dark");
    assert.ok(tab.previewMessages.some((msg) => msg.text.includes("Keyboard Shortcuts")));
    state.tabs.length = 0;
    await handleSubmittedInput(state, runtime, "ignored", tui);
  } finally {
    configureOpenTabsPath(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted input rejects invalid thinking level", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  await assert.rejects(
    handleSubmittedInput(
      state,
      { getTab: () => undefined } as unknown as RuntimeType,
      "/thinking impossible",
      {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      },
    ),
    /Unknown thinking level/,
  );
});

test("submitted input requires clear runtime replacement support", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  await assert.rejects(
    handleSubmittedInput(
      state,
      { getTab: () => undefined } as unknown as RuntimeType,
      "/clear",
      {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      },
    ),
    /Clear requires runtime session replacement support/,
  );
});

test("submitted clear fires session replacement without blocking the caller", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let finishClear!: () => void;
  let clearStarted = false;
  const renderCalled: boolean[] = [];
  const runtime = {
    clearTab: async () => {
      clearStarted = true;
      await new Promise<void>((finish) => {
        finishClear = finish;
      });
      tab.sessionId = "cleared";
      return { tab };
    },
    getTab: () => ({ chat: [] }),
  } as unknown as RuntimeType;
  await handleSubmittedInput(state, runtime, "/clear", {
    requestRender: () => {
      renderCalled.push(true);
    },
    showOverlay: () => ({}) as never,
  });
  assert.ok(renderCalled.length >= 1, "/clear must request at least one render before replacement settles");
  assert.equal(tab.status, "idle");
  assert.equal(clearStarted, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clearStarted, true);
  assert.notEqual(state.activeTabId, "cleared");
  finishClear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.activeTabId, "cleared");
});

test("submitted clear resets tab state when replacement fails", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "done",
    workingStartedAt: "2026-05-10T00:00:00.000Z",
    lastWorkedDurationSeconds: 12,
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const systemMessages: string[] = [];
  await handleSubmittedInput(
    state,
    {
      clearTab: async () => {
        throw new Error("clear failed");
      },
      appendSystemMessage: (_sessionId: string, text: string) => {
        systemMessages.push(text);
      },
    } as unknown as RuntimeType,
    "/clear",
    {
      requestRender: () => undefined,
      showOverlay: () => ({}) as never,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tab.status, "idle");
  assert.ok(systemMessages.some((msg) => msg.includes("clear failed")));
});

test("runtime enables Pi builtin tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-tools-"));
  try {
    await writeFile(join(dir, "a.txt"), "hello", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const tools = runtimeTab.agent.state.tools;
    const read = tools.find((tool) => tool.name === "read");
    const bash = tools.find((tool) => tool.name === "bash");
    const edit = tools.find((tool) => tool.name === "edit");
    const write = tools.find((tool) => tool.name === "write");
    assert.ok(read && bash && edit && write);
    assert.ok(tools.some((tool) => tool.name === "grep"));
    assert.ok(tools.some((tool) => tool.name === "find"));
    assert.ok(tools.some((tool) => tool.name === "ls"));
    assert.equal(
      tools.some((tool) => tool.name === "shell"),
      false,
    );
    assert.equal((await read.execute("1", { path: "a.txt" }, undefined)).content[0]?.type, "text");
    assert.match(
      (await bash.execute("2", { command: "printf ok" }, undefined)).content[0]?.text ?? "",
      /ok/,
    );
    const editResult = await edit.execute("3", {
      path: "a.txt",
      edits: [{ oldText: "hello", newText: "hello\nworld" }],
    });
    assert.match(editResult.content[0]?.text ?? "", /Successfully replaced/);
    await write.execute("4", { path: "b.txt", content: "created" }, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted bang command streams Pi bash locally instead of prompting the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bang-bash-"));
  try {
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const snapshots: string[] = [];
    runtime.onChange((_event, changedTab) => {
      snapshots.push(renderChat(changedTab.chat, 80).map(stripAnsi).join("\n"));
    });
    const tui = {
      requestRender: () => snapshots.push(renderChat(runtimeTab.chat, 80).map(stripAnsi).join("\n")),
      showOverlay: () => ({}) as never,
    };

    await handleSubmittedInput(
      state,
      runtime,
      "!sh -c 'printf shell-start; sleep 0.05; printf shell-end'",
      tui,
    );

    assert.equal(
      runtimeTab.chat.some((line) => line.role === "user" && line.text.includes("Run shell")),
      false,
    );
    assert.ok(snapshots.some((snapshot) => snapshot.includes("$ sh -c")));
    assert.ok(
      runtimeTab.chat.some(
        (line) =>
          line.role === "tool" &&
          line.title === "bash" &&
          line.variant === "user-bash" &&
          line.status === "success" &&
          line.text.includes("shell-startshell-end"),
      ),
    );
    await handleSubmittedInput(state, runtime, "!!printf hidden-ok", tui);
    assert.ok(
      runtimeTab.session.getEntries().some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "bashExecution" &&
          entry.message.command === "printf hidden-ok" &&
          entry.message.excludeFromContext === true,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
