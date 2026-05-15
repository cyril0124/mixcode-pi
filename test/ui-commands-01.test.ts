import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createQuestionRequest,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  renderQuestionOverlay,
  renderShellOverlay,
  tabBarHitRegions,
  setTheme,
  themeForId,
  themeSuggestions,
} from "../src/index.js";
import type { MixCodeRuntime } from "../src/index.js";
import type { Model } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL } from "../src/index.js";

type TestChatLine = { role: "system"; text: string };

function assertQuitOverlay(text: string | undefined): void {
  assert.match(text ?? "", /┌/);
  assert.match(text ?? "", /Quit MixCode/);
  assert.match(text ?? "", /\[Y\] Quit/);
}

async function waitFor<T>(read: () => Promise<T>, attempts = 25): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("theme registry validates and suggests themes", () => {
  const state = createInitialState("/repo");
  setTheme(state, "mixcode-light");
  assert.equal(state.theme, "mixcode-light");
  setTheme(state, "dark");
  assert.equal(state.theme, "mixcode-dark");
  setTheme(state, "light");
  assert.equal(state.theme, "mixcode-light");
  assert.ok(themeSuggestions("mix").length >= 2);
  assert.equal(themeSuggestions("light")[0]?.id, "mixcode-light");
  assert.ok(themeSuggestions("terminal").some((theme) => theme.id === "terminal"));
  assert.equal(themeForId("terminal").surface("plain"), "plain");
  assert.throws(() => setTheme(state, "unknown"), /Unknown theme/);
});

test("prompt templates expand supported local slash commands", () => {
  // expandLocalPromptCommand is a legacy no-op stub.
  // /compact and /undo are handled as local commands directly in app-submit.
  // Prompt template expansion is now handled by the full template system.
  assert.equal(expandLocalPromptCommand("goal", ""), undefined);
  assert.equal(expandLocalPromptCommand("goal", "ship"), undefined);
  assert.equal(expandLocalPromptCommand("compact", ""), undefined);
  assert.equal(expandLocalPromptCommand("undo", ""), undefined);
  assert.equal(expandLocalPromptCommand("brainstorm", ""), undefined);
  assert.equal(expandLocalPromptCommand("brainstorm-3", "topic"), undefined);
  assert.equal(expandLocalPromptCommand("brainstorm-4", "topic"), undefined);
  assert.equal(expandLocalPromptCommand("brainstorm-5", "topic"), undefined);
  assert.equal(expandLocalPromptCommand("review", "diff"), undefined);
  assert.equal(expandLocalPromptCommand("explain-diff", "patch"), undefined);
  assert.equal(expandLocalPromptCommand("plan", ""), undefined);
  assert.equal(expandLocalPromptCommand("plan-to-file", "ship"), undefined);
  assert.equal(expandLocalPromptCommand("update-agents-md", "prefer tests"), undefined);
  assert.equal(expandLocalPromptCommand("other", ""), undefined);
});

test("question overlay renders pending request details and empty states", () => {
  const tab = createTab(1, "s1", "/repo");
  assert.deepEqual(renderQuestionOverlay(tab, 80), []);
  tab.pendingQuestions.push(createQuestionRequest("r1", "s1", []));
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /No pending question details/);
  tab.pendingQuestions[0] = createQuestionRequest("r2", "s1", [
    {
      header: "Confirm",
      question: "Proceed?",
      options: [{ label: "Yes", description: "Continue" }],
      multiple: false,
      custom: true,
    },
  ]);
  const rendered = renderQuestionOverlay(tab, 80).join("\n");
  assert.match(rendered, /Proceed/);
  assert.match(rendered, /> \[ \] Yes/);
  assert.match(rendered, / {2}\[ \] Custom: \(empty\)/);
  tab.pendingQuestions[0].selectedAnswers[0] = ["Yes"];
  tab.pendingQuestions[0].customAnswers[0] = "Go";
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /> \[x\] Yes/);
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), / {2}\[ \] Custom: Go/);
  tab.pendingQuestions[0].highlightedOptionIndices[0] = 1;
  tab.pendingQuestions[0].editingCustomIndex = 0;
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /> \[\*\] Custom: Go/);
  tab.pendingQuestions[0] = createQuestionRequest("r2b", "s1", [
    {
      header: "Confirm",
      question: "Which?",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
      multiple: false,
      custom: false,
    },
  ]);
  tab.pendingQuestions[0].highlightedOptionIndices[0] = 1;
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), / {2}\[ \] Yes/);
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /> \[ \] No/);
  tab.pendingQuestions[0] = createQuestionRequest("r3", "s1", [
    { header: "Empty", question: "Explain?", options: [], multiple: false, custom: false },
  ]);
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /No options/);
});

test("submitted input handles compact, undo, redo, and validates theme", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const prompts: string[] = [];
  const undone: string[] = [];
  const redone: string[] = [];
  const compacted: Array<{ sessionId: string; instructions: string }> = [];
  const systemMessages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => systemMessages.push(text),
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
    getTab: () => undefined,
    undoLastUserTurn: async (sessionId: string) => undone.push(sessionId),
    redoLastUndo: async (sessionId: string) => redone.push(sessionId),
    compactSession: async (sessionId: string, instructions: string) =>
      compacted.push({ sessionId, instructions }),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };
  await handleSubmittedInput(state, runtime, "/goal ship", tui);
  assert.equal(state.tabs[0]?.goal, undefined);
  await handleSubmittedInput(state, runtime, "/compact preserve decisions", tui);
  await handleSubmittedInput(state, runtime, "/undo", tui);
  await handleSubmittedInput(state, runtime, "/redo", tui);
  assert.equal(prompts.length, 0);
  assert.deepEqual(undone, ["s1"]);
  assert.deepEqual(redone, ["s1"]);
  assert.deepEqual(compacted, [{ sessionId: "s1", instructions: "preserve decisions" }]);
  assert.ok(systemMessages.some((message) => message.includes("Unknown slash command: /goal")));
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/theme unknown", tui),
    /Unknown theme/,
  );
});

test("submitted input reloads active Pi resources", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const reloaded: string[] = [];
  const systemMessages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => systemMessages.push(text),
    extensionReload: async (sessionId: string) => {
      reloaded.push(sessionId);
    },
  } as unknown as MixCodeRuntime;
  let renders = 0;
  const tui = { requestRender: () => renders++, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/reload", tui);

  assert.deepEqual(reloaded, ["s1"]);
  assert.ok(
    systemMessages.some((message) =>
      message.includes("Reloaded keybindings, extensions, skills, prompts, and themes"),
    ),
  );
  assert.equal(renders, 1);
});

test("undo and redo keep focus on the replaced active tab", async () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo");
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s2";
  const runtime = {
    appendSystemMessage: () => undefined,
    prompt: async () => undefined,
    getTab: () => undefined,
    createTab: async () => undefined,
    forkSession: async () => undefined,
    closeTab: async () => undefined,
    closeAllTabs: async () => undefined,
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
    undoLastUserTurn: async (sessionId: string) => {
      assert.equal(sessionId, "s2");
      second.sessionId = "s2-undo";
      second.redoSessionId = "s2";
    },
    redoLastUndo: async (sessionId: string) => {
      assert.equal(sessionId, "s2-undo");
      second.sessionId = "s2";
      second.redoSessionId = undefined;
    },
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/undo", tui);
  assert.equal(state.activeTabId, "s2-undo");
  assert.equal(
    state.tabs.find((tab) => tab.sessionId === state.activeTabId),
    second,
  );

  await handleSubmittedInput(state, runtime, "/redo", tui);
  assert.equal(state.activeTabId, "s2");
  assert.equal(
    state.tabs.find((tab) => tab.sessionId === state.activeTabId),
    second,
  );
});

test("submitted input exports thinking, chatlog, and latest messages", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const runtime = {
    getTab: () => ({
      chat: [
        { role: "user", text: "question" },
        { role: "tool", text: "ok" },
        { role: "assistant", text: "answer" },
      ],
      reasoning: ["thought"],
    }),
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(100).join("\n") ?? String(component)),
      );
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/export thinking --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export chatlog --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export latest-agent --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export latest-agent-reply --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export latest-user --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export latest-user-message --editor=false", tui);
  assert.match(overlays[0] ?? "", /thought/);
  assert.match(overlays[1] ?? "", /\[assistant\] answer/);
  assert.match(overlays[2] ?? "", /\[assistant\] answer/);
  assert.match(overlays[2] ?? "", /\[tool\] ok/);
  assert.match(overlays[3] ?? "", /answer/);
  assert.match(overlays[4] ?? "", /answer/);
  assert.match(overlays[5] ?? "", /question/);
  assert.match(overlays[6] ?? "", /question/);
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/export unknown", tui),
    /Unknown export target/,
  );
});

test("submitted input exports empty fallback messages explicitly", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const runtime = {
    getTab: () => ({ chat: [], reasoning: [] }),
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(100).join("\n") ?? String(component)),
      );
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/export thinking --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export latest-agent --editor=false", tui);
  await handleSubmittedInput(state, runtime, "/export latest-user --editor=false", tui);
  assert.match(overlays[0] ?? "", /No thinking entries/);
  assert.match(overlays[1] ?? "", /No assistant message/);
  assert.match(overlays[2] ?? "", /No user message/);
  await assert.rejects(
    () =>
      handleSubmittedInput(
        state,
        { getTab: () => undefined } as unknown as MixCodeRuntime,
        "/export chatlog",
        tui,
      ),
    /Unknown tab session/,
  );
});

test("submitted input exports system-info with session, prompt, and tools", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const runtime = {
    getTab: () => ({
      chat: [],
      reasoning: [],
      session: { getSessionName: () => "test-session" },
      agent: { state: { systemPrompt: "You are a helpful assistant." } },
      agentSession: {
        getSessionStats: () => ({
          sessionFile: "/tmp/session.jsonl",
          sessionId: "s1",
          userMessages: 3,
          assistantMessages: 2,
          toolCalls: 1,
          toolResults: 1,
          totalMessages: 7,
          tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
          contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
          cost: 0.01,
        }),
        getAllTools: () => [
          { name: "bash", description: "Run shell commands" },
          { name: "read", description: "Read file contents" },
        ],
      },
    }),
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(100).join("\n") ?? String(component)),
      );
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/export system-info --editor=false", tui);
  const output = overlays[0] ?? "";
  assert.match(output, /Session Info/);
  assert.match(output, /Name: test-session/);
  assert.match(output, /User: 3/);
  assert.match(output, /System Prompt/);
  assert.match(output, /You are a helpful assistant/);
  assert.match(output, /System Tools/);
  assert.match(output, /## bash/);
  assert.match(output, /Run shell commands/);
  assert.match(output, /## read/);
  assert.match(output, /Read file contents/);
});

test("submitted input can open exported history in external editor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-export-editor-"));
  const captureFile = join(dir, "capture.txt");
  const editorScript = join(dir, "editor.sh");
  const previousEditor = process.env.EDITOR;
  try {
    await writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo");
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const chat: TestChatLine[] = [];
    const runtime = {
      appendSystemMessage: (_sessionId: string, text: string) => {
        chat.push({ role: "system", text });
        tab.previewMessages.push({ role: "system", text });
      },
      getTab: () => ({
        chat: [
          { role: "user" as const, text: "question" },
          { role: "thinking" as const, text: "reasoning step" },
          { role: "tool" as const, title: "bash", status: "success" as const, text: "ok" },
          { role: "assistant" as const, text: "answer" },
        ],
        reasoning: ["reasoning step"],
      }),
    } as unknown as MixCodeRuntime;
    const overlays: string[] = [];
    const lifecycle: string[] = [];
    const tui = {
      requestRender: () => undefined,
      showOverlay: (component: { render?: (width: number) => string[] } | string) => {
        overlays.push(
          typeof component === "string"
            ? component
            : (component.render?.(100).join("\n") ?? String(component)),
        );
        return {} as never;
      },
      stop: () => {
        lifecycle.push("stop");
      },
      start: () => {
        lifecycle.push("start");
      },
    };

    process.env.EDITOR = editorScript;
    await handleSubmittedInput(state, runtime, "/export chatlog", tui);

    const exported = await readFile(captureFile, "utf8");
    assert.match(exported, /Chat Export/);
    assert.match(exported, /\[thinking\] reasoning step/);
    assert.match(exported, /\[tool:bash:success\] ok/);
    assert.match(exported, /\[assistant\] answer/);
    assert.deepEqual(chat, []);
    assert.deepEqual(tab.previewMessages, []);
    assert.equal(
      overlays.some((overlay) => /Opened export in external editor/.test(overlay)),
      false,
    );
    assert.deepEqual(lifecycle, ["stop", "start"]);
    await handleSubmittedInput(
      state,
      runtime,
      `/export --editor=${editorScript} latest-agent`,
      tui,
    );
    assert.match(await readFile(captureFile, "utf8"), /Latest Agent Reply/);
    assert.deepEqual(lifecycle, ["stop", "start", "stop", "start"]);
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted input opens TUI state JSON in external editor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-tui-state-editor-"));
  const captureFile = join(dir, "capture.txt");
  const editorScript = join(dir, "editor.sh");
  const previousEditor = process.env.EDITOR;
  try {
    await writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo");
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const chat: TestChatLine[] = [];
    const runtime = {
      appendSystemMessage: (_sessionId: string, text: string) => {
        chat.push({ role: "system", text });
        tab.previewMessages.push({ role: "system", text });
      },
      getTab: () => undefined,
    } as unknown as MixCodeRuntime;
    const overlays: string[] = [];
    const lifecycle: string[] = [];
    const tui = {
      requestRender: () => undefined,
      showOverlay: (component: { render?: (width: number) => string[] } | string) => {
        overlays.push(
          typeof component === "string"
            ? component
            : (component.render?.(100).join("\n") ?? String(component)),
        );
        return {} as never;
      },
      stop: () => {
        lifecycle.push("stop");
      },
      start: () => {
        lifecycle.push("start");
      },
    };

    process.env.EDITOR = editorScript;
    await handleSubmittedInput(state, runtime, "/tui-state", tui);

    const exported = await readFile(captureFile, "utf8");
    assert.match(exported, /"activeTabId": "s1"/);
    assert.match(exported, /"workdir": "\/repo"/);
    assert.doesNotMatch(exported, /availableModels/);
    assert.doesNotMatch(exported, /"model"/);
    assert.doesNotMatch(exported, /previewMessages/);
    assert.doesNotMatch(exported, /pendingMessages/);
    assert.deepEqual(chat, []);
    assert.deepEqual(tab.previewMessages, []);
    assert.equal(
      overlays.some((overlay) => /Opened TUI state in external editor/.test(overlay)),
      false,
    );
    assert.deepEqual(lifecycle, ["stop", "start"]);
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    await rm(dir, { recursive: true, force: true });
  }
});
