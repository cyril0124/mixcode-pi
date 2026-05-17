import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createDialogRequest,
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

test("submitted input shows system tools when editor is disabled", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "done" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const runtime = {
    getTab: () => ({
      agentSession: {
        getAllTools: () => [
          {
            name: "read",
            description: "Read file contents",
            parameters: { type: "object" },
          },
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
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/system-tools --editor=false", tui);
  assert.match(overlays.at(-1) ?? "", /## read/);
  assert.match(overlays.at(-1) ?? "", /Read file contents/);
  await assert.rejects(
    () =>
      handleSubmittedInput(
        state,
        { getTab: () => undefined } as unknown as MixCodeRuntime,
        "/system-tools --editor=false",
        tui,
      ),
    /Unknown tab session/,
  );
});

test("submitted input shows system prompt from pi runtime when editor is disabled", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "done" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const runtime = {
    getTab: () => ({ agent: { state: { systemPrompt: "system from runtime" } } }),
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/system-prompt --editor=false", tui);
  assert.match(overlays.at(-1) ?? "", /system from runtime/);
  await assert.rejects(
    () =>
      handleSubmittedInput(
        state,
        { getTab: () => undefined } as unknown as MixCodeRuntime,
        "/system-prompt --editor=false",
        tui,
      ),
    /Unknown tab session/,
  );
});

test("submitted input shows session info from pi runtime", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "done" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const chat: TestChatLine[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => {
      chat.push({ role: "system", text });
      tab.previewMessages.push({ role: "system", text });
    },
    getTab: () => ({
      agentSession: {
        getSessionStats: () => ({
          sessionFile: "/tmp/session.jsonl",
          sessionId: "abc123",
          userMessages: 3,
          assistantMessages: 11,
          toolCalls: 18,
          toolResults: 18,
          totalMessages: 32,
          tokens: {
            input: 24_152,
            output: 3_077,
            cacheRead: 148_736,
            cacheWrite: 0,
            total: 175_965,
          },
          cost: 1.23456,
          contextUsage: {
            tokens: 9_801,
            contextWindow: 256_000,
            percent: 3.828515625,
          },
        }),
      },
      session: {
        getSessionName: () => "Daily work",
      },
    }),
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/session", tui);
  assert.deepEqual(overlays, []);
  const message = chat.at(-1)?.text ?? "";
  assert.match(message, /Session Info/);
  assert.match(message, /Name: Daily work/);
  assert.match(message, /File: \/tmp\/session\.jsonl/);
  assert.match(message, /ID: abc123/);
  assert.match(message, /Messages/);
  assert.match(message, /User: 3/);
  assert.match(message, /Assistant: 11/);
  assert.match(message, /Tool Calls: 18/);
  assert.match(message, /Tool Results: 18/);
  assert.match(message, /Total: 32/);
  assert.match(message, /Tokens/);
  assert.match(message, /Input: 24,152/);
  assert.match(message, /Output: 3,077/);
  assert.match(message, /Cache Read: 148,736/);
  assert.match(message, /Total: 175,965/);
  assert.match(message, /Context/);
  assert.match(message, /Current: 9\.80k \(9,801\)/);
  assert.match(message, /Limit: 256k \(256,000\)/);
  assert.match(message, /Usage: 3\.8%/);
  assert.match(message, /Cost/);
  assert.match(message, /Total: 1\.2346/);
  assert.equal(tab.currentContextTokens, 9_801);
  assert.equal(tab.contextLimit, 256_000);
  assert.equal(tab.previewMessages.at(-1)?.text, message);
  await assert.rejects(
    () => handleSubmittedInput(state, {} as unknown as MixCodeRuntime, "/session", tui),
    /runtime.getTab is not a function/,
  );
  await assert.rejects(
    () =>
      handleSubmittedInput(
        state,
        { getTab: () => undefined } as unknown as MixCodeRuntime,
        "/session",
        tui,
      ),
    /Unknown tab session/,
  );
});

test("submitted input and key input route interactive shell sessions", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  const opened: string[] = [];
  const closed: string[] = [];
  const written: string[] = [];
  const shellManager = {
    open: (target: typeof tab) => {
      opened.push(target.sessionId);
      target.shellOpen = true;
      target.shellSession = { cwd: target.workdir, command: "sh", buffer: [], input: "" };
      return target.shellSession;
    },
    close: (target: typeof tab) => {
      closed.push(target.sessionId);
      target.shellOpen = false;
    },
    write: (target: typeof tab, data: string) => {
      written.push(`${target.sessionId}:${data}`);
      if (data === "\u007f") target.shellSession!.input = target.shellSession!.input.slice(0, -1);
      if (data === "\u0003") target.shellSession!.input = "";
      return true;
    },
    writeMouse: (
      target: typeof tab,
      mouse: { button: number; x: number; y: number; release: boolean; wheel?: "up" | "down" },
    ) => {
      written.push(
        `${target.sessionId}:mouse:${mouse.button};${mouse.x};${mouse.y};${mouse.wheel ?? ""}`,
      );
      return true;
    },
  };
  const runtime = {
    getTab: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  shellManager.open(tab);
  assert.deepEqual(opened, ["s1"]);
  assert.equal(tab.shellOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "a", tui, shellManager), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui, shellManager), { consume: true });
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\u0003", tui, shellManager, undefined, undefined, () => false, {
      getText: () => "should not clear",
      setText: () => written.push("editor-cleared"),
    }),
    { consume: true },
  );
  assert.deepEqual(written, ["s1:a", "s1:\u007f", "s1:\u0003"]);
  tab.shellSession!.sgrMouse = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<64;4;5M", tui, shellManager), {
    consume: true,
  });
  assert.equal(tab.shellScrollOffset, 0);
  assert.equal(written.at(-1), "s1:mouse:64;4;5;up");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<0;4;5M", tui, shellManager), {
    consume: true,
  });
  assert.equal(written.at(-1), "s1:mouse:0;4;5;");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<3;4;5m", tui, shellManager), {
    consume: true,
  });
  assert.equal(written.at(-1), "s1:mouse:3;4;5;");
  tab.shellSession!.sgrMouse = false;
  tab.shellSession!.alternateScreen = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<65;4;5M", tui, shellManager), {
    consume: true,
  });
  assert.equal(written.at(-1), "s1:mouse:65;4;5;down");
  tab.shellSession!.alternateScreen = false;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, shellManager), { consume: true });
  assert.deepEqual(closed, ["s1"]);
  assert.equal(tab.shellOpen, false);
  assert.equal(tab.pendingEscapeAction, undefined);
  shellManager.open(tab);
  assert.equal(tab.shellOpen, true);
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "b", tui, shellManager), { consume: true });
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(handleMixCodeKeyInput(state, "c", tui, { write: () => false }), undefined);
  shellManager.close(tab);
  assert.deepEqual(closed, ["s1", "s1"]);
  assert.equal(tab.shellOpen, false);
  assert.equal(renders, 9);
});

test("submitted input deletes a single session or all sessions through runtime", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const deleted: string[] = [];
  const closed: string[] = [];
  const runtime = {
    getTab: () => undefined,
    closeTab: async (sessionId: string) => closed.push(sessionId),
    deleteTab: async (sessionId: string) => deleted.push(sessionId),
    deleteAllTabs: async () => deleted.push("*"),
    undoLastUserTurn: async () => undefined,
    compactSession: async () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/close-session", tui);
  assert.deepEqual(closed, ["s1"]);
  assert.deepEqual(deleted, []);
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s2"],
  );
  assert.equal(state.activeTabId, "s2");

  await handleSubmittedInput(state, runtime, "/delete-session", tui);
  assert.deepEqual(deleted, ["s2"]);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "config");

  await handleSubmittedInput(state, runtime, "/delete-all-sessions", tui);
  assert.deepEqual(deleted, ["s2", "*"]);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "config");
});

test("config-scoped submitted input runs without an active agent tab", async () => {
  const state = createInitialState("/repo");
  const created: string[] = [];
  const runtime = {
    getTab: () => undefined,
    appendSystemMessage: () => {
      throw new Error("No active tab for system message");
    },
    createTab: async (tab: { sessionId: string }) => {
      created.push(tab.sessionId);
    },
    closeAllTabs: async () => undefined,
    deleteAllTabs: async () => undefined,
  } as unknown as MixCodeRuntime;
  const overlays: string[] = [];
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

  await handleSubmittedInput(state, runtime, "/theme mixcode-light", tui);
  await handleSubmittedInput(state, runtime, "/theme dark", tui);
  assert.equal(state.theme, "mixcode-dark");
  await handleSubmittedInput(state, runtime, "/theme li", tui);
  assert.equal(state.theme, "mixcode-light");
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/theme mix", tui),
    /Ambiguous theme/,
  );
  state.picker = {
    kind: "theme",
    title: "Choose Theme",
    query: "mix",
    selectedIndex: 0,
    items: [{ id: "mixcode-light", label: "MixCode Light", description: "light" }],
  };
  await handleSubmittedInput(state, runtime, "/tui-state --editor=false", tui);
  const debugTab = createTab(1, "debug", "/repo", {
    status: "running",
    alias: "debugger",
    todoVisible: true,
    chatScrollOffset: 2,
    previewOpen: true,
    previewIndex: 1,
    previewScrollOffset: 3,
    previewHint: "preview",
    shellOpen: true,
    shellScrollOffset: 4,
    unreadDone: true,
    pendingEscapeAction: "abort",
    workingStartedAt: "2026-05-10T00:00:00.000Z",
    lastWorkedDurationSeconds: 12,
    todos: ["one", "two"],
    pendingDialogs: [
      {
        requestId: "q1",
        sessionId: "debug",
        questions: [],
        selectedAnswers: [],
        customAnswers: [],
        highlightedOptionIndices: [],
      },
    ],
    extensionUi: {
      statuses: [{ label: "ext", status: "ok" }],
      widgets: [{ id: "w1", placement: "aboveEditor", lines: ["widget"] }],
      toolsExpanded: true,
      workingVisible: false,
      workingIndicatorFrames: ["-", "\\"],
      workingIndicatorIntervalMs: 75,
      hiddenThinkingLabel: "hidden",
      workingMessage: "Working",
      title: "Extension",
      header: { lines: ["header"] },
      footer: { lines: ["footer"] },
    },
    inputMetaHitRegions: [{ action: "models", row: 10, startX: 1, endX: 5 }],
  });
  state.tabs.push(debugTab);
  state.activeTabId = "debug";
  await handleSubmittedInput(state, runtime, "/tui-state --editor=false", tui);
  state.activeTabId = "config";
  state.picker = undefined;
  await handleSubmittedInput(state, runtime, "/new-session s1", tui);
  await handleSubmittedInput(state, runtime, "/new-session", tui);
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/unknown", tui),
    /No active tab for system message/,
  );
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/exit", tui),
    /Quit command requires TUI stop support/,
  );
  assert.equal(state.theme, "mixcode-light");
  assert.ok(state.tabs.some((tab) => tab.sessionId === "s1"));
  assert.ok(state.tabs.some((tab) => /^session-\d+$/.test(tab.sessionId)));
  assert.deepEqual(
    created,
    state.tabs.filter((tab) => tab.sessionId !== "debug").map((tab) => tab.sessionId),
  );
  assert.match(overlays.join("\n"), /"version": 1/);
  assert.match(overlays.join("\n"), /"activeTabId": "config"/);
  assert.match(overlays.join("\n"), /"activeTabId": "debug"/);
  assert.match(overlays.join("\n"), /"picker": \{/);
  assert.match(overlays.join("\n"), /"statusCount": 1/);
  assert.match(overlays.join("\n"), /"widgetCount": 1/);
  assert.match(overlays.join("\n"), /"toolsExpanded": true/);
  assert.match(overlays.join("\n"), /"workingVisible": false/);
  assert.match(overlays.join("\n"), /"hasWorkingIndicatorFrames": true/);
  assert.match(overlays.join("\n"), /"workingIndicatorIntervalMs": 75/);
  assert.match(overlays.join("\n"), /"hasHiddenThinkingLabel": true/);
  assert.match(overlays.join("\n"), /"hasWorkingMessage": true/);
  assert.match(overlays.join("\n"), /"hasTitle": true/);
  assert.match(overlays.join("\n"), /"headerLineCount": 1/);
  assert.match(overlays.join("\n"), /"footerLineCount": 1/);
  assert.match(overlays.join("\n"), /"inputMetaHitRegions": \[/);
  assert.equal(
    overlays.some((overlay) => overlay.includes("/unknown")),
    false,
  );
  assert.equal(state.quitConfirmOpen, false);
});
