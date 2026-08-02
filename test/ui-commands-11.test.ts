import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
} from "../src/index.js";

test("Shift+Up/Down are not consumed as chat scroll during extension user interactions", () => {
  // C3: interaction-period Shift+Up/Down is free for extension overlay/widget
  // handleInput (pi-tui focused component after listeners). Chat scroll during
  // interactions remains available via mouse wheel.
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.pendingUserInteractions.push({ id: "ask-user-question", kind: "custom" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => true,
  };

  assert.equal(handleMixCodeKeyInput(state, "\x1b[1;2A", tui)?.consume, undefined);
  assert.equal(tab.chatScrollOffset, 0);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[1;2B", tui)?.consume, undefined);
  assert.equal(tab.chatScrollOffset, 0);
});

test("escape flushes queued messages immediately when the active tab is idle", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued request"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const flushed: string[] = [];
  const runtime = {
    flushPendingMessage: async (sessionId: string) => {
      flushed.push(sessionId);
      tab.pendingMessages = [];
    },
    getTab: () => undefined,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flushed, ["s1"]);
  assert.deepEqual(tab.pendingMessages, []);
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
    requestRender: () => undefined,
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
  assert.deepEqual(events, ["abort:s1", "flush:s1"]);
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
    requestRender: () => undefined,
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
  assert.deepEqual(events, ["abort:s1", "flush:s1:1"]);
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
    getTab: () => undefined,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlays.at(-1) ?? "", /flush failed/);
});
