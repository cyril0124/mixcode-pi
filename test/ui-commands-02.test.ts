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

test("submitted input opens local pickers and picker keys apply selections", async () => {
  const state = createInitialState("/repo");
  state.availableModels.push({
    provider: "openai",
    modelId: "gpt-4.1",
    displayName: "openai/gpt-4.1",
    contextWindow: 1_000_000,
  });
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  let overlayOpen = false;
  let renders = 0;
  const editorText = "";
  const tui = {
    requestRender: () => renders++,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {
        hide: () => {
          overlayOpen = false;
        },
      } as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };
  const thinkingUpdates: Array<{ sessionId: string; level: string }> = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => {
      tab.previewMessages.push({ role: "system", text });
      tab.previewIndex = tab.previewMessages.length - 1;
    },
    getTab: () => undefined,
    resolveModel: (provider: string, modelId: string) => ({
      ...MIXCODE_FAUX_MODEL,
      provider,
      id: modelId,
      contextWindow: modelId === "gpt-4.1" ? 1_000_000 : MIXCODE_FAUX_MODEL.contextWindow,
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
    updateTabThinkingLevel: (sessionId: string, level: "xhigh") => {
      thinkingUpdates.push({ sessionId, level });
      return level;
    },
  } as unknown as MixCodeRuntime;
  const changes: string[] = [];

  await handleSubmittedInput(state, runtime, "/models", tui, (next) =>
    changes.push(next.picker?.kind ?? "none"),
  );
  assert.equal(state.picker?.kind, "models");
  assert.match(overlays.at(-1) ?? "", /Choose Model/);
  assert.match(renderPickerOverlay(state, 80).join("\n"), /faux\/faux-1/);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\t", tui, undefined, undefined, (next) =>
      changes.push(next.picker?.kind ?? "none"),
    ),
    { consume: true },
  );
  assert.equal(state.picker?.selectedIndex, 1);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b[Z", tui, undefined, undefined, (next) =>
      changes.push(next.picker?.kind ?? "none"),
    ),
    { consume: true },
  );
  assert.equal(state.picker?.selectedIndex, 0);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "g", tui, undefined, undefined, (next) =>
      changes.push(next.picker?.kind ?? "none"),
    ),
    { consume: true },
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "p", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /openai\/gpt-4.1/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(tab.model.modelId, "gpt-4.1");
  assert.equal(state.picker, undefined);

  await handleSubmittedInput(state, runtime, "/thinking", tui, async (next) => {
    changes.push(`async:${next.picker?.kind ?? "none"}`);
  });
  assert.equal(state.picker?.kind, "thinking");
  assert.deepEqual(handleMixCodeKeyInput(state, "x", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.thinkingLevel, "xhigh");
  assert.deepEqual(thinkingUpdates, [{ sessionId: "s1", level: "xhigh" }]);

  await handleSubmittedInput(state, runtime, "/theme", tui);
  assert.equal(state.picker?.kind, "theme");
  assert.deepEqual(handleMixCodeKeyInput(state, "l", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "i", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.theme, "mixcode-light");

  await handleSubmittedInput(state, runtime, "/workdir", tui, async (next) => {
    changes.push(`async:${next.picker?.kind ?? "none"}`);
  });
  assert.equal(state.picker?.kind, "workdir");
  assert.equal(state.picker?.query, "/repo");
  assert.match(overlays.at(-1) ?? "", /filter: \/repo/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "z", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(tab.workdir, "/repo");

  await handleSubmittedInput(state, runtime, "/workdir", tui);
  assert.equal(state.picker?.kind, "workdir");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x15", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "/", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "t", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "m", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "p", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "/", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "e", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "w", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(tab.workdir, "/tmp/new");

  await handleSubmittedInput(state, runtime, "/workdir", tui);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.picker, undefined);
  assert.equal(overlayOpen, false);
  assert.ok(renders >= 8);
  assert.ok(changes.includes("models"));
  assert.ok(changes.includes("async:thinking"));
  assert.ok(changes.includes("async:workdir"));
});

test("submitted thinking command updates the Pi runtime session", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { thinkingLevel: "high" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const updates: Array<{ sessionId: string; level: string }> = [];
  const runtime = {
    updateTabThinkingLevel: (sessionId: string, level: "xhigh") => {
      updates.push({ sessionId, level });
      return level;
    },
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/thinking xhigh", {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
  });

  assert.deepEqual(updates, [{ sessionId: "s1", level: "xhigh" }]);
  assert.equal(tab.thinkingLevel, "xhigh");
  assert.equal(state.thinkingLevel, "xhigh");
});

test("workdir picker applies async runtime workdir updates", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };
  const calls: string[] = [];
  const runtime = {
    getTab: () => undefined,
    updateTabWorkdir: async (sessionId: string, workdir: string) => {
      calls.push(`${sessionId}:${workdir}`);
      tab.workdir = workdir;
    },
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/workdir", tui);
  assert.equal(state.picker?.kind, "workdir");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x15", tui, undefined, runtime), {
    consume: true,
  });
  for (const char of "/tmp/runtime") {
    assert.deepEqual(handleMixCodeKeyInput(state, char, tui, undefined, runtime), {
      consume: true,
    });
  }
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  await waitFor(() => calls.length === 1);

  assert.deepEqual(calls, ["s1:/tmp/runtime"]);
  assert.equal(tab.workdir, "/tmp/runtime");
  assert.equal(state.picker, undefined);
  assert.equal(overlayOpen, false);
  assert.match(overlays[0] ?? "", /Change Workdir/);
});

test("workdir picker completes directories before applying selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-complete-"));
  try {
    await mkdir(join(dir, "alpha"), { recursive: true });
    await writeFile(join(dir, "app.ts"), "");
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({}) as never,
      hideOverlay: () => undefined,
      hasOverlay: () => false,
    };

    await handleSubmittedInput(
      state,
      { getTab: () => undefined } as unknown as MixCodeRuntime,
      "/workdir",
      tui,
    );
    assert.equal(state.picker?.kind, "workdir");
    assert.equal(state.picker?.query, dir);
    assert.deepEqual(handleMixCodeKeyInput(state, "\x15", tui), { consume: true });
    assert.deepEqual(handleMixCodeKeyInput(state, "a", tui), { consume: true });
    assert.match(renderPickerOverlay(state, 80).join("\n"), /alpha\//);
    assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
    assert.equal(state.picker?.query, "alpha/");
    assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
    assert.equal(tab.workdir, join(dir, "alpha"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted input rejects model refs that are not registered in runtime", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  state.availableModels.push({
    provider: "custom",
    modelId: "missing",
    displayName: "custom/missing",
    contextWindow: 1000,
  });
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
  };
  await assert.rejects(
    handleSubmittedInput(
      state,
      {
        getTab: () => undefined,
        resolveModel: () => undefined,
        updateTabModel: () => undefined,
      } as unknown as MixCodeRuntime,
      "/models custom/missing",
      tui,
    ),
    /Model is not registered in runtime: custom\/missing/,
  );
});

test("picker key handling covers no-match, empty selection, and no active tab", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let overlayOpen = false;
  const overlays: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(80).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };
  state.picker = {
    kind: "models",
    title: "Choose Model",
    query: "missing",
    selectedIndex: 0,
    items: [],
  };
  assert.match(renderPickerOverlay(state, 80).join("\n"), /No matching items/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.picker?.kind, "models");

  state.picker = {
    kind: "models",
    title: "Choose Model",
    query: "",
    selectedIndex: 0,
    items: [{ id: "faux-1", label: "faux/faux-1", description: "" }],
  };
  state.tabs.length = 0;
  state.activeTabId = "config";
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.picker, undefined);

  state.picker = {
    kind: "theme",
    title: "Choose Theme",
    query: "",
    selectedIndex: 0,
    items: [{ id: "terminal", label: "Terminal", description: "" }],
  };
  assert.equal(handleMixCodeKeyInput(state, "\x00", tui), undefined);
  assert.ok(overlays.length >= 0);
});
