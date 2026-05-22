import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createInitialState, createTab, MixCodeCompletionProvider } from "../src/index.js";
import { reopenSessionInWorkdir } from "../src/agent/runtime-session.js";
import {
  applyExtensionTheme,
  availableExtensionThemes,
  currentExtensionTheme,
  extensionThemeByName,
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_LIGHT_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
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
import { addPromptHistory, insertEditorText } from "../src/ui/app-editor.js";
import {
  buildMixCodeSystemPromptOverride,
  registerMixCodeRuntimeProvider,
} from "../src/agent/runtime-provider.js";
import { resolveRuntimeModel, resolveRuntimeModelFromSession } from "../src/agent/runtime-model.js";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";

test("extension theme helpers cover host, alias, and error branches", () => {
  assert.equal(currentExtensionTheme(undefined), MIXCODE_EXTENSION_THEME);
  assert.equal(currentExtensionTheme({ getTheme: () => "light" }), MIXCODE_EXTENSION_LIGHT_THEME);
  assert.equal(currentExtensionTheme({ getTheme: () => "unknown" }), MIXCODE_EXTENSION_THEME);

  const names = availableExtensionThemes().map((theme) => theme.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(extensionThemeByName("mixcode-dark"), MIXCODE_EXTENSION_THEME);
  assert.equal(extensionThemeByName("claude-warm"), MIXCODE_EXTENSION_CLAUDE_WARM_THEME);
  assert.equal(extensionThemeByName("tokyo-night"), MIXCODE_EXTENSION_TOKYO_NIGHT_THEME);
  assert.equal(extensionThemeByName("mixcode-light"), MIXCODE_EXTENSION_LIGHT_THEME);
  assert.equal(extensionThemeByName("terminal"), MIXCODE_EXTENSION_THEME);
  assert.equal(extensionThemeByName("mixcode-extension"), MIXCODE_EXTENSION_THEME);
  assert.equal(
    extensionThemeByName(MIXCODE_EXTENSION_THEME.name ?? "mixcode-extension"),
    MIXCODE_EXTENSION_THEME,
  );
  assert.equal(extensionThemeByName("missing"), undefined);

  let renders = 0;
  assert.deepEqual(
    applyExtensionTheme("dark", undefined, () => renders++),
    {
      success: false,
      error: "Pi extension theme switching requires an active MixCode TUI host",
    },
  );
  assert.match(
    applyExtensionTheme(
      new Theme({}, {}, "truecolor"),
      {
        getTheme: () => "dark",
        setTheme: () => undefined,
      },
      () => renders++,
    ).error ?? "",
    /must have a name/,
  );
  assert.match(
    applyExtensionTheme(
      new Theme({}, {}, "truecolor", { name: "custom" }),
      {
        getTheme: () => "dark",
        setTheme: () => undefined,
      },
      () => renders++,
    ).error ?? "",
    /not switchable/,
  );

  const setThemes: string[] = [];
  assert.deepEqual(
    applyExtensionTheme(
      "light",
      {
        getTheme: () => "dark",
        setTheme: (theme) => setThemes.push(theme),
        requestRender: () => renders++,
      },
      () => renders++,
    ),
    { success: true },
  );
  assert.deepEqual(setThemes, ["mixcode-light"]);
  assert.equal(renders, 2);
  assert.deepEqual(
    applyExtensionTheme(
      "light",
      {
        getTheme: () => "dark",
        setTheme: () => {
          throw "theme failed";
        },
      },
      () => renders++,
    ),
    { success: false, error: "theme failed" },
  );
  assert.deepEqual(
    applyExtensionTheme(
      "dark",
      {
        getTheme: () => "light",
        setTheme: () => {
          throw new Error("theme error object");
        },
      },
      () => renders++,
    ),
    { success: false, error: "theme error object" },
  );
});

test("app action helpers expose model, system message, and close edge branches", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  tab.pendingEscapeAction = "close-shell";
  clearPendingEscape(tab, "abort-agent");
  assert.equal(tab.pendingEscapeAction, "close-shell");
  clearPendingEscape(tab, "close-shell");
  assert.equal(tab.pendingEscapeAction, undefined);

  const model = { provider: "p", modelId: "m", displayName: "p/m", contextWindow: 123 };
  assert.throws(
    () => applyModelSelection(state, tab, model, { resolveModel: () => undefined }),
    /Model is not registered/,
  );
  const updates: string[] = [];
  applyModelSelection(state, tab, model, {
    resolveModel: () => ({ provider: "p", id: "m", contextWindow: 123 }) as never,
    updateTabModel: (sessionId, resolved) => updates.push(`${sessionId}:${resolved.id}`),
  });
  assert.deepEqual(updates, ["s1:m"]);
  assert.equal(state.model.displayName, "p/m");

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

  await assert.rejects(
    closeRuntimeAndStop(undefined, { requestRender: () => undefined }),
    /TUI stop/,
  );
  const closed: string[] = [];
  await closeRuntimeAndStop(
    { closeAllTabs: async () => closed.push("closed") },
    { stop: () => closed.push("stopped"), requestRender: () => closed.push("render") },
  );
  assert.deepEqual(closed, ["closed", "stopped", "render"]);

  state.tabs.length = 0;
  assert.throws(
    () => appendActiveSystemMessage(state, { appendSystemMessage: () => undefined } as never, "x"),
    /No active tab/,
  );
});

test("app runtime helpers cover command and autocomplete fallbacks", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  assert.deepEqual(activeExtensionCommands(state, undefined), []);
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
  assert.deepEqual(activeExtensionCommands(state, {}), []);

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
  state.activeTabId = "missing";
  const missingProvider = createActiveAutocompleteProvider(
    state,
    {
      getTab: () => undefined,
    } as never,
    base,
  );
  assert.equal(
    (await missingProvider.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "base",
  );
  assert.equal(missingProvider.shouldTriggerFileCompletion?.(["@"], 0, 1), false);

  state.activeTabId = "config";
  const configProvider = createActiveAutocompleteProvider(state, {} as never, base);
  assert.equal(
    (await configProvider.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "base",
  );

  state.activeTabId = "s1";
  const baseWhenNoExtension = createActiveAutocompleteProvider(
    state,
    {
      getTab: () => ({}),
    } as never,
    base,
  );
  assert.equal(
    (await baseWhenNoExtension.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "base",
  );
  const activeProvider = createActiveAutocompleteProvider(
    state,
    {
      getTab: () => ({}),
      applyExtensionAutocompleteProviders: () => extension,
    } as never,
    base,
  );
  assert.equal(
    (await activeProvider.getSuggestions([""], 0, 0, {} as never))?.items[0]?.value,
    "extension",
  );
  assert.deepEqual(activeProvider.applyCompletion([""], 0, 0, {} as AutocompleteItem, ""), {
    lines: ["extension"],
    cursorLine: 0,
    cursorCol: 9,
  });
  assert.equal(activeProvider.shouldTriggerFileCompletion?.(["@"], 0, 1), true);
});

test("completion provider covers extension source and argument formatting edges", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [
      { name: "home-skill", path: homedir(), description: "" },
      {
        name: "nested-skill",
        path: join(homedir(), "mixcode-skill"),
        description: "> Summary\n- Detail",
      },
      { name: "bare-skill" },
    ],
    files: [],
    commands: [
      { name: "rawsrc", description: "raw", sourceInfo: { source: "file:local" } },
      { name: "plainpkg", description: "plain", sourceInfo: { source: "npm:plain" } },
      { name: "plainver", description: "versioned", sourceInfo: { source: "npm:plain@1" } },
      { name: "scopedplain", description: "scoped", sourceInfo: { source: "npm:@scope/pkg" } },
      { name: "fallbacksrc", description: "fallback", sourceInfo: {} },
      { name: "hintdesc", argumentHint: "<value>", description: "Has description" },
      { name: "nodesc" },
    ],
  });
  const signal = new AbortController().signal;
  assert.equal(
    (await provider.getSuggestions(["/raw"], 0, 4, { signal }))?.items[0]?.label,
    "rawsrc (ext:file:local)",
  );
  assert.equal(
    (await provider.getSuggestions(["/plainp"], 0, 7, { signal }))?.items[0]?.label,
    "plainpkg (ext:plain)",
  );
  assert.equal(
    (await provider.getSuggestions(["/plainv"], 0, 7, { signal }))?.items[0]?.label,
    "plainver (ext:plain)",
  );
  assert.equal(
    (await provider.getSuggestions(["/scoped"], 0, 7, { signal }))?.items[0]?.label,
    "scopedplain (ext:@scope/pkg)",
  );
  assert.equal(
    (await provider.getSuggestions(["/fallback"], 0, 9, { signal }))?.items[0]?.label,
    "fallbacksrc (ext:extension)",
  );
  assert.equal(
    (await provider.getSuggestions(["/hint"], 0, 5, { signal }))?.items[0]?.description,
    "<value> - Has description",
  );
  assert.equal(
    (await provider.getSuggestions(["/node"], 0, 5, { signal }))?.items[0]?.description,
    "",
  );
  assert.equal(
    (await provider.getSuggestions(["$home"], 0, 5, { signal }))?.items[0]?.description,
    "[Skill] (~)",
  );
  assert.equal(
    (await provider.getSuggestions(["$nested"], 0, 7, { signal }))?.items[0]?.description,
    "[Skill] (~/mixcode-skill) Summary Detail",
  );
  assert.equal(
    (await provider.getSuggestions(["$bare"], 0, 5, { signal }))?.items[0]?.description,
    "[Skill]",
  );
  assert.equal(await provider.getSuggestions(["/hintdesc"], 0, 9, { signal }), null);
  assert.equal(await provider.getSuggestions(["/hintdesc value"], 0, 15, { signal }), null);

  assert.deepEqual(
    provider.applyCompletion(
      ["use $nstd"],
      0,
      9,
      { value: "$nested-skill", label: "nested-skill" },
      "$nstd",
    ),
    { lines: ["use $nested-skill"], cursorLine: 0, cursorCol: 17 },
  );

  const applyMissingSkill = provider.applyCompletion(
    ["use $zz"],
    0,
    7,
    { value: "$unknown", label: "unknown" },
    "$zz",
  );
  assert.deepEqual(applyMissingSkill, { lines: ["use $unknown"], cursorLine: 0, cursorCol: 12 });
  assert.equal(await provider.getSuggestions(["/unknown value"], 0, 14, { signal }), null);
  assert.equal(await provider.getSuggestions(["plain value"], 0, 11, { signal }), null);
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

test("editor and runtime model helpers cover fallback branches", () => {
  const tab = createTab(1, "s1", "/repo");
  addPromptHistory(undefined, "ignored");
  addPromptHistory(tab, "   ");
  addPromptHistory(tab, "first");
  addPromptHistory(tab, "first");
  assert.deepEqual(tab.promptHistory, ["first"]);
  for (let index = 0; index < 105; index++) addPromptHistory(tab, `item-${index}`);
  assert.equal(tab.promptHistory.length, 100);

  let text = "base";
  insertEditorText(
    {
      getText: () => text,
      setText: (next) => {
        text = next;
      },
    },
    "+tail",
  );
  assert.equal(text, "base+tail");

  const registryModel = { provider: "custom", id: "registered", contextWindow: 10 };
  assert.equal(
    resolveRuntimeModel("custom", "registered", {
      find: () => registryModel,
    } as never),
    registryModel,
  );
  assert.equal(resolveRuntimeModel("faux", "", undefined).id, MIXCODE_FAUX_MODEL.id);
  const session = SessionManager.inMemory("/repo");
  assert.equal(
    resolveRuntimeModelFromSession(session, undefined, undefined).id,
    MIXCODE_FAUX_MODEL.id,
  );
  assert.equal(
    resolveRuntimeModelFromSession(
      session,
      { provider: "faux", id: "fallback-model", contextWindow: 1 } as never,
      undefined,
    ).id,
    "fallback-model",
  );
});

test("runtime provider bridges stream errors and runtime auth branches", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
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
  registerMixCodeRuntimeProvider(
    registry,
    model as never,
    () => Promise.reject(new Error("stream failed")) as never,
    () => "",
  );
  const registered = registry.find("custom-provider", "custom-model");
  assert.ok(registered);
  const stream = streamSimple(registered, { systemPrompt: "", messages: [], tools: [] }, {});
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events[0]?.type, "error");
  assert.equal((await stream.result()).errorMessage, "stream failed");
  assert.equal(await registry.getApiKeyForProvider("custom-provider"), "mixcode-runtime");

  const registryWithoutStream = ModelRegistry.inMemory(AuthStorage.inMemory());
  registerMixCodeRuntimeProvider(registryWithoutStream, model as never);
  assert.equal(registryWithoutStream.find("custom-provider", "custom-model"), undefined);
  registerMixCodeRuntimeProvider(registryWithoutStream, { ...model, provider: "faux" } as never);
  assert.ok(registryWithoutStream.find("faux", "custom-model"));

  const namedRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  registerMixCodeRuntimeProvider(
    namedRegistry,
    { ...model, provider: "named-provider", id: "id-only", name: undefined } as never,
    async () => {
      const out = streamSimple(
        MIXCODE_FAUX_MODEL,
        { systemPrompt: "", messages: [], tools: [] },
        {},
      );
      return out as never;
    },
    () => "runtime-key",
  );
  const idOnlyModel = namedRegistry.find("named-provider", "id-only");
  assert.equal(idOnlyModel?.name, "id-only");
  assert.equal(await namedRegistry.getApiKeyForProvider("named-provider"), "runtime-key");

  const overrideWithFallback = buildMixCodeSystemPromptOverride(undefined as never, "fallback");
  assert.equal(overrideWithFallback("base"), "base");
  assert.equal(overrideWithFallback(undefined), "fallback");
  const functionOverride = buildMixCodeSystemPromptOverride(
    (base) => `${base ?? "empty"}+override` as never,
  );
  assert.equal(functionOverride("base"), "base+override");
});
