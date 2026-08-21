import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderHome,
  renderInputMeta,
  renderPickerOverlay,
  setStateModel,
  setTabModel,
  tabBarHitRegions,
  setTheme,
  themeForId,
  listThemeInfos,
} from "./helpers/mixcode.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";
import { allKnownThinkingLevels } from "../src/core/thinking-levels.js";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL } from "./helpers/mixcode.js";

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
      await Bun.sleep(10);
    }
  }
  throw lastError;
}

test("theme registry validates and suggests themes", () => {
  const state = createInitialState("/repo");
  setTheme(state, "mixcode-dark");
  assert.equal(state.theme, "mixcode-dark");
  setTheme(state, "claude-warm");
  assert.equal(state.theme, "claude-warm");
  setTheme(state, "tokyo-night");
  assert.equal(state.theme, "tokyo-night");
  const ids = listThemeInfos().map((theme) => theme.id);
  assert.ok(ids.includes("mixcode-dark"));
  assert.ok(ids.includes("claude-warm"));
  assert.ok(ids.includes("tokyo-night"));
  assert.ok(ids.includes("terminal"));
  assert.match(themeForId("claude-warm").homeTab(" MixCode Home "), /\x1b\[48;2;217;119;87m/);
  assert.match(themeForId("tokyo-night").homeTab(" MixCode Home "), /\x1b\[48;2;122;162;247m/);
  assert.equal(themeForId("terminal").surface("plain"), "plain");
  assert.throws(() => setTheme(state, "unknown"), /Unknown theme/);
  // Pi built-in light is a valid theme id after Pi theme alignment.
  setTheme(state, "light");
  assert.equal(state.theme, "light");
});

test("thinking border colors follow Pi levels without collisions", () => {
  const levels = allKnownThinkingLevels();
  for (const themeId of [
    "mixcode-dark",
    "claude-warm",
    "tokyo-night",
    "terminal",
    "catppuccin",
    "kanagawa",
    "rose-pine",
  ]) {
    const theme = themeForId(themeId);
    const colors = levels.map((level) => theme.thinkingBorder(level)("border"));
    assert.equal(new Set(colors).size, levels.length, themeId);
    assert.deepEqual(
      levels.map((level) => theme.thinkingBorder(level)("border")),
      colors,
      `${themeId} colors must be stable`,
    );
  }
});

test("submitted input handles compact and validates theme", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const prompts: string[] = [];
  const compacted: Array<{ sessionId: string; instructions: string }> = [];
  const systemMessages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => systemMessages.push(text),
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
    getTab: () => undefined,
    getExtensionCommands: () => [],
    compactSession: async (sessionId: string, instructions: string) =>
      compacted.push({ sessionId, instructions }),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };
  await handleSubmittedInput(state, runtime, "/goal ship", tui);
  assert.equal(state.tabs[0]?.goal, undefined);
  await handleSubmittedInput(state, runtime, "/compact preserve decisions", tui);
  assert.equal(prompts.length, 0);
  assert.deepEqual(compacted, [{ sessionId: "s1", instructions: "preserve decisions" }]);
  assert.ok(systemMessages.some((message) => message.includes("Unknown slash command: /goal")));
  await handleSubmittedInput(state, runtime, "/theme unknown", tui);
  assert.ok(systemMessages.some((message) => message.includes("Unknown slash command: /theme")));
});

test("submitted input reloads active Pi resources", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const reloaded: string[] = [];
  const runtime = {
    extensionReload: async (sessionId: string) => {
      reloaded.push(sessionId);
    },
    reloadModelConfig: async () => [],
    getSharedModelRuntime: () => undefined,
    resolveModel: () => undefined,
    updateTabModel: async () => undefined,
  } as unknown as MixCodeRuntime;
  let renders = 0;
  const tui = { requestRender: () => renders++, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/reload", tui);

  assert.deepEqual(reloaded, ["s1"]);
  assert.match(
    state.tabs[0]!.toast?.message ?? "",
    /Reloaded keybindings, extensions, skills, prompts, themes, and models/,
  );
  assert.equal(renders, 1);
});

test("/reload refreshes models.json and rebuilds the selectable model list", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  // Start with a stale selection that disappears after the reload.
  setStateModel(state, {
    provider: "acme",
    modelId: "old",
    displayName: "acme/old",
    contextWindow: 1000,
  });
  setTabModel(state.tabs[0]!, state.model);

  const updatedTabModels: Array<{ sessionId: string; modelId: string }> = [];
  // Simulate models.json now exposing only acme/new (acme/old was removed).
  const refreshed: Model<any>[] = [
    {
      id: "new",
      provider: "acme",
      api: "openai",
      contextWindow: 4096,
    } as unknown as Model<any>,
  ];
  const runtime = {
    extensionReload: async () => {},
    reloadModelConfig: () =>
      refreshed.map((model) => ({
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      })),
    getSharedModelRuntime: () => undefined,
    resolveModel: (provider: string, modelId: string) =>
      refreshed.find((model) => model.provider === provider && model.id === modelId),
    updateTabModel: (sessionId: string, model: Model<any>) =>
      updatedTabModels.push({ sessionId, modelId: model.id }),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => {}, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/reload", tui);

  // The picker list keeps the faux default plus the freshly configured model.
  assert.deepEqual(
    state.availableModels.map((model) => `${model.provider}/${model.modelId}`),
    ["faux/faux-1", "acme/new"],
  );
  // The stale acme/old selection is repaired to the configured acme/new.
  assert.equal(state.model.modelId, "new");
  assert.equal(state.tabs[0]!.model.modelId, "new");
  // The active tab's live runtime session is synced to the repaired model.
  assert.deepEqual(updatedTabModels, [{ sessionId: "s1", modelId: "new" }]);
  assert.match(state.tabs[0]!.toast?.message ?? "", /and models/);
});

test("/reload keeps model selection when models.json fails to load", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  setStateModel(state, {
    provider: "acme",
    modelId: "old",
    displayName: "acme/old",
    contextWindow: 1000,
  });
  setTabModel(state.tabs[0]!, state.model);
  const beforeModels = state.availableModels.map((model) => `${model.provider}/${model.modelId}`);

  const updatedTabModels: Array<{ sessionId: string; modelId: string }> = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.getError = () => "Failed to parse models.json: Unexpected token";
  const runtime = {
    extensionReload: async () => {},
    reloadModelConfig: async () => [],
    getSharedModelRuntime: () => modelRuntime,
    resolveModel: () => undefined,
    updateTabModel: (sessionId: string, model: { id: string }) =>
      updatedTabModels.push({ sessionId, modelId: model.id }),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => {}, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/reload", tui);

  assert.deepEqual(
    state.availableModels.map((model) => `${model.provider}/${model.modelId}`),
    beforeModels,
  );
  assert.equal(state.model.modelId, "old");
  assert.equal(state.tabs[0]!.model.modelId, "old");
  assert.deepEqual(updatedTabModels, []);
  const toast = state.tabs[0]!.toast?.message ?? "";
  assert.match(toast, /models failed/);
  assert.match(toast, /Failed to parse models.json/);
  assert.doesNotMatch(toast, /themes, and models/);
});

test("unknown slash commands keep focus on the active tab", async () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo");
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s2";
  const systemMessages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => systemMessages.push(text),
    prompt: async () => undefined,
    getTab: () => undefined,
    getExtensionCommands: () => [],
    createTab: async () => undefined,
    forkSession: async () => undefined,
    closeTab: async () => undefined,
    closeAllTabs: async () => undefined,
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/no-such-command", tui);
  assert.equal(state.activeTabId, "s2");
  assert.ok(
    systemMessages.some((message) => message.includes("Unknown slash command: /no-such-command")),
  );
});

test("submitted input opens TUI state JSON in external editor", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-tui-state-editor-"));
  const captureFile = path.join(dir, "capture.txt");
  const editorScript = path.join(dir, "editor.sh");
  const previousEditor = process.env.EDITOR;
  try {
    await fsPromises.writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });
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
      pause: () => {
        lifecycle.push("pause");
      },
      resume: () => {
        lifecycle.push("resume");
      },
    };

    process.env.EDITOR = editorScript;
    await handleSubmittedInput(state, runtime, "/tui-state", tui);

    const exported = await fsPromises.readFile(captureFile, "utf8");
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
    assert.deepEqual(lifecycle, ["pause", "resume"]);
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
