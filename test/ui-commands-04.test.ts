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
  renderHotkeysText,
  renderInputMeta,
  renderPickerOverlay,
  renderQuestionOverlay,
  tabBarHitRegions,
  setTheme,
  themeForId,
  themeSuggestions,
} from "../src/index.js";
import type { MixCodeRuntime } from "../src/index.js";
import type { Model } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL } from "../src/index.js";

type TestChatLine = { role: "system"; text: string };

function createOverlayCaptureTui() {
  const overlays: string[] = [];
  let visible = false;
  return {
    overlays,
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      visible = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(100).join("\n") ?? String(component)),
      );
      return { hide: () => { visible = false; } };
    },
    hasOverlay: () => visible,
    hideOverlay: () => { visible = false; },
  };
}

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

test("global key input dispatches extension shortcuts only from the main editor surface", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let overlayOpen = false;
  const dispatched: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
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
  const runtime = {
    dispatchExtensionShortcut: (sessionId: string, data: string) => {
      dispatched.push(`${sessionId}:${JSON.stringify(data)}`);
      return data === "\x18";
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x18", tui, undefined, runtime), {
    consume: true,
  });
  assert.deepEqual(dispatched, ['s1:"\\u0018"']);
  state.picker = { kind: "thinking", title: "Thinking", query: "", selectedIndex: 0, items: [] };
  assert.equal(handleMixCodeKeyInput(state, "\x18", tui, undefined, runtime), undefined);
  assert.deepEqual(dispatched, ['s1:"\\u0018"']);
  state.picker = undefined;
  overlayOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x18", tui, undefined, runtime), undefined);
  assert.deepEqual(dispatched, ['s1:"\\u0018"']);
});

test("global key input leaves extension custom overlay input to pi-tui focus", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const dispatched: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hideOverlay: () => {
      throw new Error("MixCode key handler must not close extension-owned overlays");
    },
    hasOverlay: () => true,
  };
  const runtime = {
    hasExtensionCustomOverlay: (sessionId: string) => sessionId === "s1",
    dispatchExtensionShortcut: (sessionId: string, data: string) => {
      dispatched.push(`${sessionId}:${data}`);
      return true;
    },
  };
  const changes: string[] = [];

  assert.equal(handleMixCodeKeyInput(state, "x", tui, undefined, runtime), undefined);
  assert.equal(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), undefined);
  assert.equal(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), undefined);
  assert.deepEqual(dispatched, []);
});

test("global key input gives extension custom escape priority over streaming abort", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  let focused = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    hasExtensionCustomOverlay: (sessionId: string) => sessionId === "s1",
    focusExtensionCustomOverlay: (sessionId: string) => {
      assert.equal(sessionId, "s1");
      focused++;
    },
    abortTab: () => {
      aborts++;
      return true;
    },
  };

  assert.equal(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), undefined);
  assert.equal(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), undefined);
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(aborts, 0);
  assert.equal(focused, 2);
});

test("submitted hotkeys command shows built-in and extension shortcuts", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat: TestChatLine[] = [];
  let renders = 0;
  const runtime = {
    appendSystemMessage: (sessionId: string, text: string) => {
      assert.equal(sessionId, "s1");
      chat.push({ role: "system", text });
      tab.previewMessages.push({ role: "system", text });
    },
    getTab: (sessionId: string) => {
      assert.equal(sessionId, "s1");
      return {
        agentSession: {
          extensionRunner: {
            getShortcuts: () =>
              new Map([
                [
                  "ctrl+alt+w",
                  {
                    description: "Toggle BTW overlay focus",
                    extensionPath: "/repo/.pi/extensions/btw.ts",
                  },
                ],
              ]),
          },
        },
      };
    },
  } as unknown as MixCodeRuntime;
  const tui = {
    requestRender: () => {
      renders++;
    },
    showOverlay: () => {
      throw new Error("hotkeys should be shown as a system message");
    },
  };

  await handleSubmittedInput(state, runtime, "/hotkeys", tui);

  const message = chat.at(-1)?.text ?? "";
  assert.match(message, /Keyboard Shortcuts/);
  assert.match(message, /Global/);
  assert.match(message, /\| `Ctrl\+P` \| Open command palette \|/);
  assert.match(message, /Other/);
  assert.match(message, /\| `\/` \| Slash commands \|/);
  assert.match(message, /Extensions/);
  assert.match(message, /\| `Ctrl\+Alt\+W` \| Toggle BTW overlay focus \|/);
  assert.equal(tab.previewMessages.at(-1)?.text, message);
  assert.equal(renders, 1);
});

test("hotkeys text includes bash commands without extensions", () => {
  const text = renderHotkeysText();

  assert.match(text, /Keyboard Shortcuts/);
  assert.match(text, /Command Palette/);
  assert.match(text, /\| `Enter` \| Run selected command or show disabled reason \|/);
  assert.match(text, /\| `!` \| Run bash command \|/);
  assert.match(text, /\| `!!` \| Run bash command \(excluded from context\) \|/);
  assert.doesNotMatch(text, /Extensions/);
});

test("submitted input saves, restores, and deletes workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
    state.activeTabId = "s2";
    const systemMessages: string[] = [];
    const overlays: string[] = [];
    const renders: string[] = [];
    const runtime = {
      appendSystemMessage: (_sessionId: string, text: string) => systemMessages.push(text),
      getTab: () => undefined,
    } as unknown as MixCodeRuntime;
    const tui = {
      requestRender: () => renders.push("render"),
      showOverlay: (component: { render?: (width: number) => string[] } | string) => {
        overlays.push(
          typeof component === "string"
            ? component
            : (component.render?.(100).join("\n") ?? String(component)),
        );
        return {} as never;
      },
    };

    await handleSubmittedInput(
      state,
      runtime,
      "/save-workspace main",
      tui,
      undefined,
      undefined,
      workspaceFile,
    );
    state.tabs.reverse();
    await handleSubmittedInput(
      state,
      runtime,
      "/restore-workspace main",
      tui,
      undefined,
      undefined,
      workspaceFile,
    );
    assert.deepEqual(
      state.tabs.map((tab) => tab.sessionId),
      ["s1", "s2"],
    );
    assert.equal(state.activeTabId, "s2");
    await handleSubmittedInput(
      state,
      runtime,
      "/delete-workspace main",
      tui,
      undefined,
      undefined,
      workspaceFile,
    );
    assert.deepEqual(systemMessages, []);
    assert.equal(state.tabs.find((tab) => tab.sessionId === state.activeTabId)?.toast?.message, "Workspace deleted: main");
    assert.doesNotMatch(
      overlays.join("\n"),
      /Workspace saved: main|Workspace restored: main|Workspace deleted: main/,
    );
    assert.equal(renders.length, 3);
    await writeFile(workspaceFile, "[]", "utf8");
    await assert.rejects(
      () =>
        handleSubmittedInput(
          state,
          runtime,
          "/restore-workspace missing",
          tui,
          undefined,
          undefined,
          workspaceFile,
        ),
      /Unknown workspace/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace commands expose missing configuration and arguments", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/save-workspace main", tui),
    /Workspace file is not configured/,
  );
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/restore-workspace main", tui),
    /Workspace file is not configured/,
  );
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/delete-workspace main", tui),
    /Workspace file is not configured/,
  );
  const overlayTui = createOverlayCaptureTui();
  await handleSubmittedInput(
    state,
    runtime,
    "/save-workspace",
    overlayTui,
    undefined,
    undefined,
    join(tmpdir(), "unused-workspaces.json"),
  );
  assert.equal(state.workspaceOverlay.mode, "save");
});

test("workspace save surfaces invalid workspace files instead of treating them as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-invalid-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    await writeFile(workspaceFile, "{ invalid json", "utf8");
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    state.activeTabId = "s1";
    const runtime = {
      getTab: () => undefined,
    } as unknown as MixCodeRuntime;
    const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

    await assert.rejects(
      () =>
        handleSubmittedInput(
          state,
          runtime,
          "/save-workspace main",
          tui,
          undefined,
          undefined,
          workspaceFile,
        ),
      /Unexpected token|Expected property name/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted input marks done, exports state, imports sessions, and exits directly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-tui-state-toggle-"));
  const captureFile = join(dir, "capture.txt");
  const editorScript = join(dir, "editor.sh");
  await writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const renders: string[] = [];
  const overlays: string[] = [];
  const lifecycle: string[] = [];
  let stopped = false;
  let closedAll = 0;
  const tui = {
    requestRender: () => renders.push("render"),
    showOverlay: (component: { render: (width: number) => string[] }) => {
      overlays.push(component.render(120).join("\n"));
      return {} as never;
    },
    stop: () => {
      lifecycle.push("stop");
      stopped = true;
    },
    start: () => {
      lifecycle.push("start");
    },
  };
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => {
      tab.previewMessages.push({ role: "system", text });
      tab.previewIndex = tab.previewMessages.length - 1;
    },
    getTab: () => undefined,
    importFromJsonl: async (_sessionId: string, path: string, cwdOverride?: string) => {
      overlays.push(`import:${path}:${cwdOverride ?? ""}`);
      return { cancelled: false };
    },
    closeTab: async () => undefined,
    closeAllTabs: async () => {
      closedAll++;
    },
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    undoLastUserTurn: async () => undefined,
    compactSession: async () => undefined,
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/mark-done", tui);
  assert.equal(tab.status, "done");
  assert.equal(tab.unreadDone, true);
  await handleSubmittedInput(state, runtime, `/tui-state --editor=${editorScript}`, tui);
  assert.match(await readFile(captureFile, "utf8"), /"activeTabId": "s1"/);
  assert.deepEqual(tab.previewMessages, []);
  assert.deepEqual(lifecycle, ["stop", "start"]);
  await handleSubmittedInput(state, runtime, "/import ./session.jsonl /repo", tui);
  assert.equal(overlays.at(-1), "import:./session.jsonl:/repo");
  assert.equal(tab.toast?.message, "Imported session: ./session.jsonl");
  runtime.importFromJsonl = async (_sessionId: string, path: string, cwdOverride?: string) => {
    overlays.push(`cancelled-import:${path}:${cwdOverride ?? ""}`);
    return { cancelled: true };
  };
  await handleSubmittedInput(state, runtime, "/import ./cancelled.jsonl", tui);
  assert.equal(overlays.at(-1), "cancelled-import:./cancelled.jsonl:");
  assert.equal(tab.toast?.message, "Import cancelled.");
  await handleSubmittedInput(state, runtime, "/exit", tui);
  assert.equal(stopped, true);
  assert.equal(closedAll, 1);
  assert.equal(state.quitConfirmOpen, false);
  assert.equal(renders.length, 7);
  await rm(dir, { recursive: true, force: true });
});

test("submitted quit command exposes missing TUI stop support", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/quit", tui),
    /Quit command requires TUI stop support/,
  );
});

test("submitted input opens system prompt in external editor by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-prompt-editor-"));
  const captureFile = join(dir, "capture.txt");
  const editorScript = join(dir, "editor.sh");
  const previousEditor = process.env.EDITOR;
  try {
    await writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo", { status: "done" });
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const overlays: string[] = [];
    const lifecycle: string[] = [];
    const runtime = {
      appendSystemMessage: (_sessionId: string, text: string) => {
        tab.previewMessages.push({ role: "system", text });
      },
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
      stop: () => {
        lifecycle.push("stop");
      },
      start: () => {
        lifecycle.push("start");
      },
    };

    process.env.EDITOR = editorScript;
    await handleSubmittedInput(state, runtime, "/system-prompt", tui);

    assert.match(await readFile(captureFile, "utf8"), /system from runtime/);
    assert.deepEqual(tab.previewMessages, []);
    assert.equal(
      overlays.some((overlay) => /Opened system prompt in external editor/.test(overlay)),
      false,
    );
    assert.deepEqual(lifecycle, ["stop", "start"]);
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    await rm(dir, { recursive: true, force: true });
  }
});

test("submitted input opens system tools in external editor by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-tools-editor-"));
  const captureFile = join(dir, "capture.txt");
  const editorScript = join(dir, "editor.sh");
  const previousEditor = process.env.EDITOR;
  try {
    await writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo", { status: "done" });
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const overlays: string[] = [];
    const lifecycle: string[] = [];
    const runtime = {
      appendSystemMessage: (_sessionId: string, text: string) => {
        tab.previewMessages.push({ role: "system", text });
      },
      getTab: () => ({ agentSession: { getAllTools: () => [] } }),
      getExtensionTools: () => [
        {
          name: "extension_echo",
          description: "Echo extension input",
          parameters: { type: "object", properties: { text: { type: "string" } } },
          sourceInfo: {
            source: "npm:example-extension@1.0.0",
            scope: "project",
            origin: "package",
            path: "/repo/ext.ts",
          },
        },
      ],
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
      stop: () => {
        lifecycle.push("stop");
      },
      start: () => {
        lifecycle.push("start");
      },
    };

    process.env.EDITOR = editorScript;
    await handleSubmittedInput(state, runtime, "/system-tools", tui);

    const exported = await readFile(captureFile, "utf8");
    assert.match(exported, /System Tools/);
    assert.match(exported, /## extension_echo/);
    assert.match(exported, /Echo extension input/);
    assert.match(exported, /npm:example-extension@1\.0\.0/);
    assert.match(exported, /parameters:/);
    assert.deepEqual(tab.previewMessages, []);
    assert.equal(
      overlays.some((overlay) => /Opened system tools in external editor/.test(overlay)),
      false,
    );
    assert.deepEqual(lifecycle, ["stop", "start"]);
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    await rm(dir, { recursive: true, force: true });
  }
});
