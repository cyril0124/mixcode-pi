import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
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

test("global key input scrolls chat with Shift+Up/Down during extension user interactions", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.pendingUserInteractions.push({ id: "ask-user-question", kind: "custom" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hasOverlay: () => true,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1;2A", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 3);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1;2B", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  assert.equal(renders, 2);
});

test("escape flushes queued messages immediately when the active tab is idle", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued request"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders += 1;
    },
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const flushed: string[] = [];
  const runtime = {
    flushPendingMessage: async (sessionId: string) => {
      flushed.push(sessionId);
      tab.pendingMessages = [];
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flushed, ["s1"]);
  assert.deepEqual(tab.pendingMessages, []);
  assert.ok(renders >= 1);
});

test("escape aborts the active run and flushes queued messages before double-escape stop", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "thinking",
    pendingMessages: ["queued request"],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const events: string[] = [];
  const tui = {
    requestRender: () => {
      events.push("render");
    },
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: (sessionId: string) => {
      events.push(`abort:${sessionId}`);
      tab.status = "idle";
      return true;
    },
    flushPendingMessage: async (sessionId: string) => {
      events.push(`flush:${sessionId}`);
      tab.pendingMessages = [];
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((event) => event !== "render"),
    ["abort:s1", "flush:s1"],
  );
  assert.deepEqual(tab.pendingMessages, []);
  assert.equal(tab.pendingEscapeAction, undefined);
});

test("escape flushes runtime queued messages even before tab queue state catches up", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const events: string[] = [];
  const tui = {
    requestRender: () => {
      events.push("render");
    },
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({
      queuedPromptCount: 1,
      agent: { state: { isStreaming: true } },
      agentSession: { getSteeringMessages: () => ["queued request"] },
    }),
    abortTab: (sessionId: string) => {
      events.push(`abort:${sessionId}`);
      return true;
    },
    flushPendingMessage: async (sessionId: string, count?: number) => {
      events.push(`flush:${sessionId}:${count ?? "all"}`);
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((event) => event !== "render"),
    ["abort:s1", "flush:s1:1"],
  );
  assert.equal(tab.pendingEscapeAction, undefined);
});

test("escape flush queued message errors are shown in an overlay", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued request"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(80).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hasOverlay: () => false,
  };
  const runtime = {
    flushPendingMessage: async () => {
      throw new Error("flush failed");
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlays.at(-1) ?? "", /flush failed/);
});
