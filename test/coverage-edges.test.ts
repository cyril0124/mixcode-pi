import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/index.js";
import { listAllSessionsGlobal, reopenSessionInWorkdir } from "../src/agent/runtime-session.js";
import {
  applyExtensionTheme,
  extensionThemeByName,
  MIXCODE_EXTENSION_THEME,
} from "../src/agent/runtime-extension-theme.js";
import {
  appendActiveSystemMessage,
  applyModelSelection,
  clearPendingEscape,
  closeRuntimeAndStop,
  showSystemMessageOrToast,
} from "../src/ui/app-actions.js";
import {
  activeExtensionCommands,
  createActiveAutocompleteProvider,
} from "../src/ui/app-runtime.js";
import { addPromptHistory } from "../src/ui/app-editor.js";
import {
  buildMixCodeSystemPromptOverride,
  registerMixCodeRuntimeProvider,
} from "../src/agent/runtime-provider.js";
import { resolveRuntimeModel, resolveRuntimeModelFromSession } from "../src/agent/runtime-model.js";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";

test("extension theme lookup and apply reject unknown or hostless switches", () => {
  assert.equal(extensionThemeByName("mixcode-dark"), MIXCODE_EXTENSION_THEME);
  assert.equal(extensionThemeByName("missing"), undefined);

  assert.deepEqual(applyExtensionTheme("dark", undefined, () => undefined), {
    success: false,
    error: "Pi extension theme switching requires an active MixCode TUI host",
  });

  const setThemes: string[] = [];
  assert.deepEqual(
    applyExtensionTheme(
      "light",
      {
        getTheme: () => "dark",
        setTheme: (theme) => setThemes.push(theme),
      },
      () => undefined,
    ),
    { success: false, error: "Unknown theme: light" },
  );
  assert.deepEqual(setThemes, []);
});

test("model selection rejects unregistered models and commits registered ones", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  const model = { provider: "p", modelId: "m", displayName: "p/m", contextWindow: 123 };
  await assert.rejects(
    async () => applyModelSelection(state, tab, model, { resolveModel: () => undefined }),
    /Model is not registered/,
  );

  const updates: string[] = [];
  await applyModelSelection(state, tab, model, {
    resolveModel: () => ({ provider: "p", id: "m", contextWindow: 123 }) as never,
    updateTabModel: async (sessionId, resolved) => {
      updates.push(`${sessionId}:${resolved.id}`);
    },
  });
  assert.deepEqual(updates, ["s1:m"]);
  assert.equal(state.model.displayName, "p/m");
});

test("pending escape clears only the matching action", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.pendingEscapeAction = "close-shell";
  clearPendingEscape(tab, "abort-agent");
  assert.equal(tab.pendingEscapeAction, "close-shell");
  clearPendingEscape(tab, "close-shell");
  assert.equal(tab.pendingEscapeAction, undefined);
});

test("system messages go to the active tab; config falls back to overlay toast", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  const overlays: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string" ? component : (component.render?.(80).join("\n") ?? ""),
      );
      return {} as never;
    },
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  showSystemMessageOrToast({ ...state, activeTabId: "config" }, {}, tui, "toast");
  assert.match(overlays.at(-1) ?? "", /toast/);

  const systemMessages: string[] = [];
  appendActiveSystemMessage(
    state,
    {
      appendSystemMessage: (_sessionId, message) => systemMessages.push(message),
    } as never,
    "system",
  );
  showSystemMessageOrToast(
    state,
    {
      appendSystemMessage: (_sessionId, message) => systemMessages.push(message),
    } as never,
    tui,
    "notice",
  );
  assert.deepEqual(systemMessages, ["system", "notice"]);

  state.tabs.length = 0;
  assert.throws(
    () => appendActiveSystemMessage(state, { appendSystemMessage: () => undefined } as never, "x"),
    /No active tab/,
  );
});

test("closeRuntimeAndStop stops the TUI then closes tabs", async () => {
  await assert.rejects(
    closeRuntimeAndStop(undefined, { requestRender: () => undefined }),
    /TUI stop/,
  );
  const closed: string[] = [];
  await closeRuntimeAndStop(
    { closeAllTabs: async () => closed.push("closed") },
    { stop: () => closed.push("stopped"), requestRender: () => closed.push("render") },
  );
  assert.deepEqual(closed, ["stopped", "closed", "render"]);
});

test("active extension commands come from the active tab, or all tabs on config", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  assert.deepEqual(
    activeExtensionCommands(state, {
      getExtensionCommands: (sessionId) => [{ name: sessionId }],
    } as never),
    [{ name: "s1" }],
  );

  state.activeTabId = "config";
  assert.deepEqual(
    activeExtensionCommands(state, {
      getAllExtensionCommands: () => [{ name: "all" }],
    } as never),
    [{ name: "all" }],
  );
});

test("autocomplete prefers the active tab extension provider over the base provider", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  const base: AutocompleteProvider = {
    getSuggestions: async () => ({ prefix: "b", items: [{ value: "base", label: "base" }] }),
    applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 4 }),
  };
  const extension: AutocompleteProvider = {
    getSuggestions: async () => ({
      prefix: "e",
      items: [{ value: "extension", label: "extension" }],
    }),
    applyCompletion: () => ({ lines: ["extension"], cursorLine: 0, cursorCol: 9 }),
    shouldTriggerFileCompletion: () => true,
  };

  const withoutExtension = createActiveAutocompleteProvider(
    state,
    {
      getTab: () => ({}),
      applyExtensionAutocompleteProviders: (_sessionId: string, provider: AutocompleteProvider) =>
        provider,
    } as never,
    base,
  );
  assert.equal(
    (await withoutExtension.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "base",
  );

  const withExtension = createActiveAutocompleteProvider(
    state,
    {
      getTab: () => ({}),
      applyExtensionAutocompleteProviders: () => extension,
    } as never,
    base,
  );
  assert.equal(
    (await withExtension.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "extension",
  );
  assert.deepEqual(withExtension.applyCompletion([""], 0, 0, {} as AutocompleteItem, ""), {
    lines: ["extension"],
    cursorLine: 0,
    cursorCol: 9,
  });
});

test("runtime all-session listing includes sessions whose cwd is not filesystem root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-list-all-sessions-"));
  try {
    const rootStateDir = join(dir, "state");
    const currentSessionsRoot = join(rootStateDir, "workdirs", "current", "sessions");
    const otherSessionsRoot = join(rootStateDir, "workdirs", "other", "sessions");
    await mkdir(currentSessionsRoot, { recursive: true });
    await mkdir(otherSessionsRoot, { recursive: true });

    const current = SessionManager.create("/repo-current", currentSessionsRoot);
    current.newSession({ id: "current-session" });
    current.appendMessage({ role: "user", content: "current cwd session", timestamp: 1 });
    current.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "current response" }],
      provider: "faux",
      model: "faux-1",
      timestamp: 2,
    });

    const other = SessionManager.create("/repo-other", otherSessionsRoot);
    other.newSession({ id: "other-session" });
    other.appendMessage({ role: "user", content: "other cwd session", timestamp: 3 });
    other.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "other response" }],
      provider: "faux",
      model: "faux-1",
      timestamp: 4,
    });

    const sessions = await listAllSessionsGlobal(currentSessionsRoot, rootStateDir);
    assert.deepEqual(
      sessions.map((session) => session.id).sort(),
      ["current-session", "other-session"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime session reopens non-persisted sessions in a new cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-reopen-session-"));
  try {
    const oldDir = join(dir, "old");
    const newDir = join(dir, "new");
    const sessionsRoot = join(dir, "sessions");
    const source = SessionManager.inMemory(oldDir);
    source.newSession({ id: "s1" });
    source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    assert.equal(source.getSessionFile(), undefined);

    const reopened = await reopenSessionInWorkdir(source, newDir, sessionsRoot);
    assert.equal(reopened.getCwd(), newDir);
    assert.equal(reopened.getSessionId(), "s1");
    assert.ok(reopened.getSessionFile());
    assert.equal(reopened.getBranch()[0]?.type, "message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompt history dedupes consecutive repeats and caps at 100", () => {
  const tab = createTab(1, "s1", "/repo");
  addPromptHistory(tab, "first");
  addPromptHistory(tab, "first");
  assert.deepEqual(tab.promptHistory, ["first"]);
  addPromptHistory(tab, "older");
  addPromptHistory(tab, "first");
  assert.deepEqual(tab.promptHistory, ["first", "older"]);
  for (let index = 0; index < 105; index++) addPromptHistory(tab, `item-${index}`);
  assert.equal(tab.promptHistory.length, 100);
});

test("runtime model resolution falls back to faux when registry has no match", () => {
  assert.equal(resolveRuntimeModel("faux", "", undefined).id, MIXCODE_FAUX_MODEL.id);
  const session = SessionManager.inMemory("/repo");
  assert.equal(
    resolveRuntimeModelFromSession(session, undefined, undefined).id,
    MIXCODE_FAUX_MODEL.id,
  );
});

test("runtime provider bridges stream failures and system-prompt overrides", async () => {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = {
    provider: "custom-provider",
    id: "custom-model",
    name: "Custom Model",
    api: "custom-api",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
  };

  await registerMixCodeRuntimeProvider(
    modelRuntime,
    model as never,
    () => Promise.reject(new Error("stream failed")) as never,
    () => "",
  );
  const registered = modelRuntime.getModel("custom-provider", "custom-model");
  assert.ok(registered);
  // Route through ModelRuntime (the non-deprecated path AgentSession uses):
  // the registered provider's bridged streamSimple must surface the streamFn
  // failure as an error event.
  const stream = modelRuntime.streamSimple(
    registered,
    { systemPrompt: "", messages: [], tools: [] },
    {},
  );
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events[0]?.type, "error");
  assert.equal((await stream.result()).errorMessage, "stream failed");
  assert.equal(
    modelRuntime.getRegisteredProviderConfig("custom-provider")?.apiKey,
    "mixcode-runtime",
  );

  // Async getApiKey must be awaited into the provider config, not dropped as a Promise.
  await registerMixCodeRuntimeProvider(
    modelRuntime,
    { ...model, provider: "async-key-provider", api: "async-key-api" } as never,
    () => Promise.reject(new Error("unused")) as never,
    async () => "sk-from-async",
  );
  assert.equal(
    modelRuntime.getRegisteredProviderConfig("async-key-provider")?.apiKey,
    "sk-from-async",
  );

  // Sync throw from streamFn must become a bridged error event, not an uncaught exception.
  await registerMixCodeRuntimeProvider(
    modelRuntime,
    { ...model, provider: "sync-throw-provider", api: "sync-throw-api" } as never,
    () => {
      throw new Error("sync stream boom");
    },
  );
  const syncThrowModel = modelRuntime.getModel("sync-throw-provider", "custom-model");
  assert.ok(syncThrowModel);
  const syncStream = modelRuntime.streamSimple(
    syncThrowModel,
    { systemPrompt: "", messages: [], tools: [] },
    {},
  );
  const syncEvents = [];
  for await (const event of syncStream) syncEvents.push(event);
  assert.equal(syncEvents[0]?.type, "error");
  assert.equal((await syncStream.result()).errorMessage, "sync stream boom");

  const overrideWithFallback = buildMixCodeSystemPromptOverride(undefined as never, "fallback");
  assert.equal(overrideWithFallback("base"), "base");
  assert.equal(overrideWithFallback(undefined), "fallback");
  const functionOverride = buildMixCodeSystemPromptOverride(
    (base) => `${base ?? "empty"}+override` as never,
  );
  assert.equal(functionOverride("base"), "base+override");
  // String override is applied as-is (not silently replaced by base).
  const stringOverride = buildMixCodeSystemPromptOverride("fixed-prompt" as never, "fallback");
  assert.equal(stringOverride("base"), "fixed-prompt");
  assert.equal(stringOverride(undefined), "fixed-prompt");
});
