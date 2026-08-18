import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "./helpers/mixcode.js";
import { listAllSessionsGlobal, reopenSessionInWorkdir } from "../src/agent/runtime-session.js";
import {
  applyExtensionTheme,
  extensionThemeByName,
  MIXCODE_EXTENSION_THEME,
} from "../src/agent/runtime-extension-theme.js";
import { clearPendingEscape } from "../src/core/escape.js";
import {
  appendActiveSystemMessage,
  applyModelSelection,
  showSystemMessageOrToast,
} from "../src/ui/app-actions.js";
import {
  activeExtensionCommands,
  createActiveAutocompleteProvider,
} from "../src/ui/app-runtime.js";
import { applyExtensionAutocompleteProviders } from "../src/agent/runtime-extension-ui.js";
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

  assert.deepEqual(applyExtensionTheme("mixcode-dark", undefined, () => undefined), {
    success: false,
    error: "Pi extension theme switching requires an active MixCode TUI host",
  });

  const setThemes: string[] = [];
  assert.deepEqual(
    applyExtensionTheme(
      "not-a-real-theme",
      {
        getTheme: () => "dark",
        setTheme: (theme) => setThemes.push(theme),
      },
      () => undefined,
    ),
    { success: false, error: "Unknown theme: not-a-real-theme" },
  );
  assert.deepEqual(setThemes, []);

  // Pi built-in light is loadable and switches when a host is present.
  assert.deepEqual(
    applyExtensionTheme(
      "light",
      {
        getTheme: () => "dark",
        setTheme: (theme) => setThemes.push(theme),
      },
      () => undefined,
    ),
    { success: true },
  );
  assert.deepEqual(setThemes, ["light"]);
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

test("clearPendingEscape clears an armed abort confirm", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.pendingEscapeArmedAt = 1_700_000_000_000;
  clearPendingEscape(tab);
  assert.equal(tab.pendingEscapeArmedAt, undefined);
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

  showSystemMessageOrToast({ ...state, activeTabId: "home" }, {}, tui, "toast");
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

  state.activeTabId = "home";
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
      applyExtensionAutocompleteProviders: () => ({
        ...extension,
        triggerCharacters: ["$"],
      }),
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
  // Pi Editor reads provider.triggerCharacters; extension wrappers must surface "$".
  assert.ok(withExtension.triggerCharacters?.includes("$"));
});

test("live autocomplete proxy keeps per-active-tab extension wrappers after rebind", async () => {
  // Production host always rebinds the multi-tab live proxy (never a single-session
  // concrete chain). Switching active tab must change which extension wrappers run.
  const state = createInitialState("/repo");
  const tabA = createTab(1, "s1", "/repo");
  const tabB = createTab(2, "s2", "/repo");
  state.tabs.push(tabA, tabB);
  state.activeTabId = "s1";

  const base: AutocompleteProvider = {
    triggerCharacters: ["@", "#"],
    getSuggestions: async () => ({
      prefix: "",
      items: [{ value: "base", label: "base" }],
    }),
    applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 4 }),
  };

  const runtimeTabs = {
    s1: {
      extensionAutocompleteProviderFactories: [
        (current: AutocompleteProvider): AutocompleteProvider => ({
          ...current,
          triggerCharacters: ["$", ...(current.triggerCharacters ?? [])],
          getSuggestions: async () => ({
            prefix: "",
            items: [{ value: "from-s1", label: "from-s1" }],
          }),
        }),
      ],
      extensionAutocompleteProviderCache: undefined as
        | { base: AutocompleteProvider; factoryCount: number; provider: AutocompleteProvider }
        | undefined,
    },
    s2: {
      extensionAutocompleteProviderFactories: [] as Array<
        (provider: AutocompleteProvider) => AutocompleteProvider
      >,
      extensionAutocompleteProviderCache: undefined as
        | { base: AutocompleteProvider; factoryCount: number; provider: AutocompleteProvider }
        | undefined,
    },
  };

  const runtime = {
    getTab: (id: string) => runtimeTabs[id as keyof typeof runtimeTabs],
    applyExtensionAutocompleteProviders: (sessionId: string, b: AutocompleteProvider) =>
      applyExtensionAutocompleteProviders(
        runtimeTabs[sessionId as keyof typeof runtimeTabs] as never,
        b,
      ),
  };

  // Live proxy (same object app.ts binds into EditorSlot).
  const live = createActiveAutocompleteProvider(state, runtime as never, base);
  // Warm cache for s1 (boot path reads triggerCharacters).
  assert.ok(live.triggerCharacters?.includes("$"));
  assert.equal(
    (await live.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "from-s1",
  );

  // addAutocompleteProvider rebind signal: invalidate + keep the same live proxy.
  runtimeTabs.s1.extensionAutocompleteProviderCache = undefined;
  const rebound = live; // host always rebinds live, never a concrete s1 chain

  state.activeTabId = "s2";
  assert.equal(
    (await rebound.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "base",
    "tab B must not freeze on tab A wrappers",
  );
  // s2 has no $ factory; after resolve, trigger list comes from base only.
  const s2Triggers = rebound.triggerCharacters ?? [];
  assert.ok(s2Triggers.includes("@"));
  assert.ok(!s2Triggers.includes("$"), "tab B must not inherit tab A $ trigger from live resolve");
});


test("runtime session reopens non-persisted sessions in a new cwd", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-reopen-session-"));
  try {
    const oldDir = path.join(dir, "old");
    const newDir = path.join(dir, "new");
    const sessionsRoot = path.join(dir, "sessions");
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
    await fsPromises.rm(dir, { recursive: true, force: true });
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
