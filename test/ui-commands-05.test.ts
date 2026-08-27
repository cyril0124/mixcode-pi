import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  configureOpenTabsPath,
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  openTabsFile,
  readOpenTabs,
  writeOpenTabs,
} from "./helpers/mixcode.js";
import { UUIDV7_SESSION_ID_PATTERN } from "./helpers/session-id.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";

type TestChatLine = { role: "system"; text: string; kind?: string };

async function waitFor<T>(read: () => Promise<T>, attempts = 25): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await Bun.sleep(10);
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
    // No extension tools → fall back to the agent session's built-in tools.
    getExtensionTools: () => undefined,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
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
  assert.match(overlays.at(-1) ?? "", /## == read ==/);
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

test("submitted input only accepts bare system prompt command", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "done" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => ({ agentSession: { systemPrompt: "system from runtime" } }),
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
  };

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/system-prompt --editor=false", tui),
    /Usage: \/system-prompt/,
  );
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/system-prompt extra", tui),
    /Usage: \/system-prompt/,
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
    appendSystemMessage: (_sessionId: string, text: string, kind?: string) => {
      chat.push({ role: "system", text, kind });
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
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
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
  // Pi handleSessionCommand permanently appends (not showStatus coalesce).
  assert.equal(chat.at(-1)?.kind, "plain");
  assert.match(message, /Session Info/);
  assert.match(message, /Tab: Agent-01/);
  assert.match(message, /Workdir: \/repo/);
  assert.match(message, /Name: Daily work/);
  assert.match(message, /File: \/tmp\/session\.jsonl/);
  assert.match(message, /ID: abc123/);
  assert.match(message, /Messages/);
  // Pi: Total first, Tools combined line.
  assert.match(message, /Total: 32/);
  assert.match(message, /User: 3/);
  assert.match(message, /Assistant: 11/);
  assert.match(message, /Tools: 18 calls, 18 results/);
  assert.doesNotMatch(message, /Tool Calls:/);
  assert.doesNotMatch(message, /Tool Results:/);
  assert.match(message, /Tokens/);
  // Pi Input is full prompt volume (input + cacheRead + cacheWrite).
  assert.match(message, /Input: 172,888/);
  assert.match(message, /Cached: 148,736 \(86\.0%\)/);
  assert.match(message, /Uncached: 24,152/);
  assert.match(message, /Output: 3,077/);
  assert.match(message, /Total: 175,965/);
  // Context is footer-only side effect, not part of Pi dump.
  assert.doesNotMatch(message, /\bContext\b/);
  assert.doesNotMatch(message, /Current:/);
  assert.match(message, /Cost/);
  assert.match(message, /Total: \$1\.235/);
  assert.equal(tab.currentContextTokens, 9_801);
  assert.equal(tab.contextLimit, 256_000);
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

test("submitted input confirms a single session close/delete before touching runtime", async () => {
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
    compactSession: async () => undefined,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  let confirmationOptions: { anchor?: unknown; width?: unknown; margin?: unknown } | undefined;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (
      _component: unknown,
      options?: { anchor?: unknown; width?: unknown; margin?: unknown },
    ) => {
      confirmationOptions = options;
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/close-session", tui);
  assert.deepEqual(confirmationOptions, { anchor: "center", width: 72, margin: 1 });
  assert.deepEqual(closed, []);
  assert.deepEqual(deleted, []);
  assert.deepEqual(state.sessionActionConfirm, { action: "close", sessionId: "s1" });
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1", "s2"],
  );

  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
    consume: true,
  });
  await waitFor(async () => assert.deepEqual(closed, ["s1"]));
  assert.equal(state.sessionActionConfirm, null);
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s2"],
  );
  assert.equal(state.activeTabId, "s2");

  await handleSubmittedInput(state, runtime, "/delete-session", tui);
  assert.deepEqual(deleted, []);
  assert.deepEqual(state.sessionActionConfirm, { action: "delete", sessionId: "s2" });

  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
    consume: true,
  });
  await waitFor(async () => assert.deepEqual(deleted, ["s2"]));
  assert.equal(state.sessionActionConfirm, null);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "home");

  // /delete-all-sessions keeps its existing Y/N confirmation path.
  await handleSubmittedInput(state, runtime, "/delete-all-sessions", tui);
  assert.deepEqual(deleted, ["s2"]);
  assert.equal(state.deleteAllSessionsConfirmOpen, true);

  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
    consume: true,
  });
  await waitFor(async () => assert.deepEqual(deleted, ["s2", "*"]));
  assert.equal(state.deleteAllSessionsConfirmOpen, false);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "home");
});

test("submitted input /close-session yes and /delete-session yes skip confirmation", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const deleted: string[] = [];
  const closed: string[] = [];
  const runtime = {
    getTab: () => undefined,
    closeTab: async (sessionId: string) => closed.push(sessionId),
    deleteTab: async (sessionId: string) => deleted.push(sessionId),
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  let overlayOpened = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpened = true;
      return {} as never;
    },
  };

  await handleSubmittedInput(state, runtime, "/close-session yes", tui);
  assert.equal(overlayOpened, false);
  assert.equal(state.sessionActionConfirm, null);
  assert.deepEqual(closed, ["s1"]);
  assert.equal(state.activeTabId, "s2");

  await handleSubmittedInput(state, runtime, "/delete-session y", tui);
  assert.equal(overlayOpened, false);
  assert.deepEqual(deleted, ["s2"]);
  // Read through a local: assert.deepEqual is `asserts actual is T`, so
  // asserting on state.tabs directly would pin it to never[] below.
  const tabsAfterDelete = state.tabs;
  assert.deepEqual(tabsAfterDelete, []);
  assert.equal(state.activeTabId, "home");

  state.tabs.push(createTab(1, "s3", "/repo"));
  state.activeTabId = "s3";
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/close-session maybe", tui),
    /Usage: \/close-session \[yes\]/,
  );
  assert.equal(state.sessionActionConfirm, null);
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s3"],
  );
});

test("single session close/delete confirmation cancel leaves tabs untouched", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const deleted: string[] = [];
  const closed: string[] = [];
  const runtime = {
    getTab: () => undefined,
    closeTab: async (sessionId: string) => closed.push(sessionId),
    deleteTab: async (sessionId: string) => deleted.push(sessionId),
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return { hide: () => (overlayOpen = false) } as never;
    },
    hasOverlay: () => overlayOpen,
  };

  await handleSubmittedInput(state, runtime, "/close-session", tui);
  assert.equal(state.sessionActionConfirm?.action, "close");
  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui, undefined, runtime), {
    consume: true,
  });
  const confirmAfterCancel = state.sessionActionConfirm;
  assert.equal(confirmAfterCancel, null);
  assert.equal(overlayOpen, false);

  await handleSubmittedInput(state, runtime, "/delete-session", tui);
  assert.equal(state.sessionActionConfirm?.action, "delete");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.sessionActionConfirm, null);
  assert.deepEqual(closed, []);
  assert.deepEqual(deleted, []);
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1", "s2"],
  );
  assert.equal(state.activeTabId, "s1");
});

test("delete-all-sessions confirmation cancel (n or Escape) leaves tabs untouched", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const deleted: string[] = [];
  const runtime = {
    getTab: () => undefined,
    deleteAllTabs: async () => deleted.push("*"),
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  // showOverlay must return a handle with `hide` so hasAnyOverlay(tui) reports
  // true while the confirm overlay is open (needed for the Escape-key path,
  // which routes through the shared escape dispatcher before reaching the
  // deleteAllSessionsConfirmOpen check).
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return { hide: () => (overlayOpen = false) } as never;
    },
    hasOverlay: () => overlayOpen,
  };

  await handleSubmittedInput(state, runtime, "/delete-all-sessions", tui);
  assert.equal(state.deleteAllSessionsConfirmOpen, true);

  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.deleteAllSessionsConfirmOpen, false);
  assert.deepEqual(deleted, []);
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1", "s2"],
  );

  await handleSubmittedInput(state, runtime, "/delete-all-sessions", tui);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.deleteAllSessionsConfirmOpen, false);
  assert.deepEqual(deleted, []);
  assert.equal(state.tabs.length, 2);
});

test("submitted input closes all sessions through runtime after Y/N confirmation", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const closedAll: string[] = [];
  const runtime = {
    getTab: () => undefined,
    closeAllTabs: async () => closedAll.push("*"),
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  // /close-all-sessions opens the same kind of Y/N confirmation as
  // /delete-all-sessions, but confirming calls closeAllTabs (tabs close,
  // session files are kept) instead of deleteAllTabs.
  await handleSubmittedInput(state, runtime, "/close-all-sessions", tui);
  assert.deepEqual(closedAll, []);
  assert.equal(state.closeAllSessionsConfirmOpen, true);
  assert.equal(state.tabs.length, 2);

  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
    consume: true,
  });
  await waitFor(async () => assert.deepEqual(closedAll, ["*"]));
  assert.equal(state.closeAllSessionsConfirmOpen, false);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "home");
});

test("close-all-sessions clears the shared open-tab set", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-close-all-open-tabs-"));
  const filePath = openTabsFile(dir);
  try {
    configureOpenTabsPath(filePath);
    writeOpenTabs(filePath, ["s1", "s2"]);
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
    state.activeTabId = "s1";
    const runtime = {
      getTab: () => undefined,
      closeAllTabs: async () => undefined,
      getPromptHistory: () => [],
      setExtensionUiHost: () => undefined,
      getExtensionCommands: () => [],
      getAllExtensionCommands: () => [],
      onTabClosed: () => () => undefined,
      onModelsChanged: () => () => undefined,
      appendSystemMessage: () => undefined,
      getSharedModelRuntime: () => undefined,
      getExtensionTools: () => [],
      applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
    } as unknown as MixCodeRuntime;
    const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

    await handleSubmittedInput(state, runtime, "/close-all-sessions", tui);
    assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
      consume: true,
    });
    await waitFor(async () => assert.equal(state.tabs.length, 0));

    assert.deepEqual(readOpenTabs(filePath), []);
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("delete-all-sessions clears the shared open-tab set", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-delete-all-open-tabs-"));
  const filePath = openTabsFile(dir);
  try {
    configureOpenTabsPath(filePath);
    writeOpenTabs(filePath, ["s1", "s2"]);
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
    state.activeTabId = "s1";
    const runtime = {
      getTab: () => undefined,
      deleteAllTabs: async () => undefined,
      getPromptHistory: () => [],
      setExtensionUiHost: () => undefined,
      getExtensionCommands: () => [],
      getAllExtensionCommands: () => [],
      onTabClosed: () => () => undefined,
      onModelsChanged: () => () => undefined,
      appendSystemMessage: () => undefined,
      getSharedModelRuntime: () => undefined,
      getExtensionTools: () => [],
      applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
    } as unknown as MixCodeRuntime;
    const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

    await handleSubmittedInput(state, runtime, "/delete-all-sessions", tui);
    assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
      consume: true,
    });
    await waitFor(async () => assert.equal(state.tabs.length, 0));

    assert.deepEqual(readOpenTabs(filePath), []);
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

// Regression coverage: MixCodeRuntime.deleteAllTabs()/closeAllTabs() are real
// class methods that read `this.tabs` internally. Detaching either method from
// its runtime instance before calling it (e.g. `const fn = runtime.deleteAllTabs;
// fn()`) loses `this` and throws "Cannot read properties of undefined (reading
// 'tabs')" — this shipped once (fixed by always calling `runtime.xxx()` through
// the object). Arrow-function mocks never catch this because arrow functions
// have no own `this`, so these two tests use real prototype methods instead.
test("delete-all-sessions confirmation calls runtime.deleteAllTabs bound to the runtime instance", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  class FakeRuntime {
    tabs = new Set(["s1", "s2"]);
    getTab() {
      return undefined;
    }
    async deleteAllTabs() {
      this.tabs.clear();
    }
  }
  const fakeRuntime = new FakeRuntime();
  const runtime = fakeRuntime as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/delete-all-sessions", tui);
  assert.equal(state.deleteAllSessionsConfirmOpen, true);

  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
    consume: true,
  });
  await waitFor(async () => assert.equal(fakeRuntime.tabs.size, 0));
  assert.equal(state.deleteAllSessionsConfirmOpen, false);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "home");
});

test("close-all-sessions confirmation calls runtime.closeAllTabs bound to the runtime instance", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  class FakeRuntime {
    tabs = new Set(["s1", "s2"]);
    getTab() {
      return undefined;
    }
    async closeAllTabs() {
      this.tabs.clear();
    }
  }
  const fakeRuntime = new FakeRuntime();
  const runtime = fakeRuntime as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/close-all-sessions", tui);
  assert.equal(state.closeAllSessionsConfirmOpen, true);

  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), {
    consume: true,
  });
  await waitFor(async () => assert.equal(fakeRuntime.tabs.size, 0));
  assert.equal(state.closeAllSessionsConfirmOpen, false);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "home");
});

test("close-all-sessions confirmation cancel (n or Escape) leaves tabs untouched", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const closedAll: string[] = [];
  const runtime = {
    getTab: () => undefined,
    closeAllTabs: async () => closedAll.push("*"),
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return { hide: () => (overlayOpen = false) } as never;
    },
    hasOverlay: () => overlayOpen,
  };

  await handleSubmittedInput(state, runtime, "/close-all-sessions", tui);
  assert.equal(state.closeAllSessionsConfirmOpen, true);

  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.closeAllSessionsConfirmOpen, false);
  assert.deepEqual(closedAll, []);
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1", "s2"],
  );

  await handleSubmittedInput(state, runtime, "/close-all-sessions", tui);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.closeAllSessionsConfirmOpen, false);
  assert.deepEqual(closedAll, []);
  assert.equal(state.tabs.length, 2);
});

test("new-session rolls back the tab and active id when runtime.createTab fails", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "done" }));
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => undefined,
    createTab: async () => {
      throw new Error("create failed");
    },
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/new-session", tui),
    /create failed/,
  );
  // Rollback: the half-created tab is removed and the previous tab stays active.
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1"],
  );
  assert.equal(state.activeTabId, "s1");
});

test("/new-session <name> creates a tab titled like /new-session then /rename", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "done", title: "Agent-01" }));
  state.activeTabId = "s1";
  const renamed: Array<{ sessionId: string; title: string }> = [];
  const runtime = {
    getTab: () => undefined,
    createTab: async () => undefined,
    renameSession: (sessionId: string, title: string) => {
      renamed.push({ sessionId, title });
    },
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/new-session API-Gateway", tui);

  const created = state.tabs.find((tab) => tab.sessionId !== "s1");
  assert.ok(created, "new tab was created");
  assert.equal(created.title, "API-Gateway");
  assert.equal(state.activeTabId, created.sessionId);
  assert.deepEqual(renamed, [{ sessionId: created.sessionId, title: "API-Gateway" }]);
});

function commandRuntime(overrides: Record<string, unknown> = {}) {
  return {
    getTab: () => undefined,
    createTab: async () => undefined,
    renameSession: () => undefined,
    forkSession: async () => undefined,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: unknown) => base,
    ...overrides,
  } as unknown as MixCodeRuntime;
}

test("/new-session <name> suffixes a title already used by an open tab", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }));
  state.activeTabId = "s1";
  const renamed: Array<{ sessionId: string; title: string }> = [];
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(
    state,
    commandRuntime({
      renameSession: (sessionId: string, title: string) => {
        renamed.push({ sessionId, title });
      },
    }),
    "/new-session Worker",
    tui,
  );

  const created = state.tabs.find((tab) => tab.sessionId !== "s1");
  assert.ok(created, "new tab was created");
  assert.equal(created.title, "Worker-1");
  assert.deepEqual(renamed, [{ sessionId: created.sessionId, title: "Worker-1" }]);
});

test("/new-session --no-focus creates a tab without switching UI focus", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "done", title: "Agent-01" }));
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, commandRuntime(), "/new-session --no-focus", tui);

  const created = state.tabs.find((tab) => tab.sessionId !== "s1");
  assert.ok(created, "new tab was created");
  assert.equal(state.activeTabId, "s1");
  assert.notEqual(created.sessionId, "s1");
});

test("/new-session --no-focus Title names the tab and keeps current focus", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "done", title: "Agent-01" }));
  state.activeTabId = "s1";
  const renamed: Array<{ sessionId: string; title: string }> = [];
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(
    state,
    commandRuntime({
      renameSession: (sessionId: string, title: string) => {
        renamed.push({ sessionId, title });
      },
    }),
    "/new-session --no-focus API Gateway",
    tui,
  );

  const created = state.tabs.find((tab) => tab.sessionId !== "s1");
  assert.ok(created, "new tab was created");
  assert.equal(created.title, "API Gateway");
  assert.equal(state.activeTabId, "s1");
  assert.deepEqual(renamed, [{ sessionId: created.sessionId, title: "API Gateway" }]);
});

test("/new-session Title --no-focus names Title and keeps current focus", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, commandRuntime(), "/new-session Worker --no-focus", tui);

  const created = state.tabs.find((tab) => tab.sessionId !== "s1");
  assert.ok(created, "new tab was created");
  assert.equal(created.title, "Worker");
  assert.equal(state.activeTabId, "s1");
});

test("/new-session --focus Title focuses the new tab", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, commandRuntime(), "/new-session --focus Worker", tui);

  const created = state.tabs.find((tab) => tab.sessionId !== "s1");
  assert.ok(created, "new tab was created");
  assert.equal(created.title, "Worker");
  assert.equal(state.activeTabId, created.sessionId);
});

test("/new-session rejects --focus and --no-focus together", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await assert.rejects(
    () =>
      handleSubmittedInput(state, commandRuntime(), "/new-session --no-focus --focus Worker", tui),
    /Error: Usage: \/new-session \[--focus\|--no-focus\] \[title\]/,
  );
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1"],
  );
  assert.equal(state.activeTabId, "s1");
});

test("/new-session --no-focus rolls back the tab and leaves the previous active id", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "done" }));
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await assert.rejects(
    () =>
      handleSubmittedInput(
        state,
        commandRuntime({
          createTab: async () => {
            throw new Error("create failed");
          },
        }),
        "/new-session --no-focus Worker",
        tui,
      ),
    /create failed/,
  );
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1"],
  );
  assert.equal(state.activeTabId, "s1");
});

test("/fork of the same source a second time suffixes -1", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }));
  state.activeTabId = "s1";
  const renamed: string[] = [];
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };
  const runtime = commandRuntime({
    renameSession: (_sessionId: string, title: string) => {
      renamed.push(title);
    },
  });

  await handleSubmittedInput(state, runtime, "/fork", tui);
  assert.equal(state.tabs[1]?.title, "Worker-fork");
  state.activeTabId = "s1";
  await handleSubmittedInput(state, runtime, "/fork", tui);

  // Second fork inserts after the source, so it sits before the first fork.
  assert.deepEqual(
    state.tabs.map((tab) => tab.title),
    ["Worker", "Worker-fork-1", "Worker-fork"],
  );
  assert.deepEqual(renamed, ["Worker-fork", "Worker-fork-1"]);
});

test("/rename refuses a title already used by another open tab", async () => {
  const state = createInitialState("/repo");
  const worker = createTab(1, "s1", "/repo", { title: "Worker" });
  const other = createTab(2, "s2", "/repo", { title: "Other" });
  state.tabs.push(worker, other);
  state.activeTabId = "s2";
  const renamed: string[] = [];
  const system: string[] = [];
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(
    state,
    commandRuntime({
      renameSession: (_sessionId: string, title: string) => {
        renamed.push(title);
      },
      appendSystemMessage: (_sessionId: string, text: string) => {
        system.push(text);
      },
    }),
    "/rename Worker",
    tui,
  );

  assert.equal(other.title, "Other");
  assert.equal(worker.title, "Worker");
  assert.deepEqual(renamed, []);
  assert.deepEqual(system, []);
  assert.equal(other.toast?.type, "warning");
  assert.match(other.toast?.message ?? "", /already in use: Worker/);
});

test("fork rolls back the fork tab and restores the source tab when createTab fails", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "done" }));
  state.activeTabId = "s1";
  let forked: string | undefined;
  const runtime = {
    getTab: () => undefined,
    forkSession: async (_source: string, newId: string) => {
      forked = newId;
      return {} as never;
    },
    createTab: async () => {
      throw new Error("fork create failed");
    },
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/fork", tui),
    /fork create failed/,
  );
  assert.notEqual(forked, undefined);
  // Rollback: the fork tab is removed and the source tab regains focus.
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1"],
  );
  assert.equal(state.activeTabId, "s1");
});

test("fork from Home inserts after the selected source tab, not at bar head", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Agent-01" }),
    createTab(2, "s2", "/repo", { title: "Agent-02" }),
    createTab(3, "s3", "/repo", { title: "Agent-03" }),
  );
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 1; // Agent-02
  let forkedId = "";
  const runtime = {
    getTab: () => undefined,
    forkSession: async (_source: string, newId: string) => {
      forkedId = newId;
      return {} as never;
    },
    createTab: async () => undefined,
    renameSession: () => undefined,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(
    state,
    runtime,
    "/fork",
    tui,
    undefined,
    undefined,
    undefined,
    state.tabs[1],
  );

  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s1", "s2", forkedId, "s3"],
  );
  assert.equal(state.tabs[2]?.title, "Agent-02-fork");
});

test("config-scoped submitted input runs without an active agent tab", async () => {
  const state = createInitialState("/repo");
  const created: string[] = [];
  const runtime = {
    getTab: () => undefined,
    appendSystemMessage: () => {
      throw new Error("No active tab for system message");
    },
    renameSession: () => undefined,
    createTab: async (tab: { sessionId: string }) => {
      created.push(tab.sessionId);
    },
    closeAllTabs: async () => undefined,
    deleteAllTabs: async () => undefined,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
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

  // Theme is no longer a slash command; setTheme still drives workdir state.
  const { setTheme } = await import("../src/ui/themes.js");
  setTheme(state, "tokyo-night");
  assert.equal(state.theme, "tokyo-night");
  setTheme(state, "mixcode-dark");
  assert.equal(state.theme, "mixcode-dark");
  // Keep a picker snapshot so /tui-state still exercises the picker dump path.
  state.picker = {
    kind: "models",
    title: "Choose Model",
    query: "tok",
    selectedIndex: 0,
    items: [{ id: "tokyo-night", label: "Tokyo Night", description: "dark" }],
  };
  await handleSubmittedInput(state, runtime, "/tui-state --editor=false", tui);
  const debugTab = createTab(1, "debug", "/repo", {
    status: "running",
    chatScrollOffset: 2,
    unreadDone: true,

    workingStartedAt: "2026-05-10T00:00:00.000Z",
    lastWorkedDurationSeconds: 12,
    extensionUi: {
      statuses: [{ key: "ext", text: "ok" }],
      widgets: [{ key: "w1", placement: "aboveEditor", lines: ["widget"] }],
      toolsExpanded: true,
      waitingForInputs: [],
      workingVisible: false,
      workingIndicatorFrames: ["-", "\\"],
      workingIndicatorIntervalMs: 75,
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
  state.activeTabId = "home";
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
  assert.equal(state.theme, "mixcode-dark");
  assert.equal(
    state.tabs.some((tab) => tab.sessionId === "s1"),
    false,
  );
  assert.equal(
    state.tabs.some((tab) => /^session-\d+$/.test(tab.sessionId)),
    false,
  );
  assert.equal(created.length, 2);
  assert.equal(
    created.every((sessionId) => UUIDV7_SESSION_ID_PATTERN.test(sessionId)),
    true,
  );
  assert.deepEqual(
    created,
    state.tabs.filter((tab) => tab.sessionId !== "debug").map((tab) => tab.sessionId),
  );
  assert.match(overlays.join("\n"), /"version": 1/);
  assert.match(overlays.join("\n"), /"activeTabId": "home"/);
  assert.match(overlays.join("\n"), /"activeTabId": "debug"/);
  assert.match(overlays.join("\n"), /"picker": \{/);
  assert.match(overlays.join("\n"), /"statusCount": 1/);
  assert.match(overlays.join("\n"), /"widgetCount": 1/);
  assert.match(overlays.join("\n"), /"toolsExpanded": true/);
  assert.match(overlays.join("\n"), /"workingVisible": false/);
  assert.match(overlays.join("\n"), /"hasWorkingIndicatorFrames": true/);
  assert.match(overlays.join("\n"), /"workingIndicatorIntervalMs": 75/);
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
