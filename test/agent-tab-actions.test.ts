import assert from "node:assert/strict";
import { test } from "node:test";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { createBatchExecutorHost } from "../src/cli/batch-host.js";
import { createInitialState, createTab } from "../src/core/defaults.js";

test("batch input rejects MixCode local commands instead of prompting the agent", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const prompts: string[] = [];
  const runtime = {
    prompt: async (_sessionId: string, prompt: string) => {
      prompts.push(prompt);
    },
    getTab: () => undefined,
    getExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const host = createBatchExecutorHost({
    state,
    runtime,
    tui: { requestRender: () => undefined },
  });

  await assert.rejects(
    () => host.submitInput("s1", "/settings"),
    /Batch prompt cannot execute MixCode local command: \/settings/,
  );
  assert.deepEqual(prompts, []);
});

test("batch clear resets the same chat anchors as TUI clear", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    chatScrollAnchorEntryId: "entry-1",
    chatScrollAnchorIndex: 4,
    chatScrollAnchorText: "anchored prompt",
  });
  state.tabs.push(tab);
  const runtime = {
    getTab: () => ({
      chat: [],
      agentSession: { isStreaming: false, isBashRunning: false },
    }),
    clearTabChatProjection: () => undefined,
    clearTab: async () => ({ tab }),
  } as unknown as MixCodeRuntime;
  const host = createBatchExecutorHost({
    state,
    runtime,
    tui: { requestRender: () => undefined },
  });

  await host.clearTab("s1");

  assert.equal(tab.chatScrollAnchorEntryId, undefined);
  assert.equal(tab.chatScrollAnchorIndex, undefined);
  assert.equal(tab.chatScrollAnchorText, undefined);
});

test("batch clear publishes the empty tab before session replacement starts", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  const events: string[] = [];
  const runtime = {
    getTab: () => {
      events.push("read-chat");
      return {
        chat: [],
        agentSession: { isStreaming: false, isBashRunning: false },
      };
    },
    clearTabChatProjection: () => undefined,
    clearTab: async () => {
      events.push("replace-session");
      return { tab };
    },
  } as unknown as MixCodeRuntime;
  const host = createBatchExecutorHost({
    state,
    runtime,
    tui: { requestRender: () => events.push("render") },
  });

  await host.clearTab("s1");

  assert.deepEqual(events, ["read-chat", "render", "replace-session", "render"]);
});

test("batch create marks customBasePrompt when system_prompt overrides base", async () => {
  const state = createInitialState("/repo");
  const runtime = {
    resolveModel: () => ({
      provider: "faux",
      id: "faux-1",
      name: "faux-1",
      api: "faux",
      contextWindow: 200_000,
      maxTokens: 1,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    createTab: async () => undefined,
    renameSession: () => undefined,
  } as unknown as MixCodeRuntime;
  const host = createBatchExecutorHost({
    state,
    runtime,
    tui: { requestRender: () => undefined },
  });

  await host.createNewTab({
    name: "reviewer",
    prompt: "go",
    systemPrompt: "You are a strict reviewer.",
  });

  assert.equal(state.tabs[0]?.title, "reviewer");
  assert.equal(state.tabs[0]?.customBasePrompt, true);
});

test("batch clear sets customBasePrompt when system_prompt is provided", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "reviewer" });
  state.tabs.push(tab);
  const runtime = {
    getTab: () => ({
      chat: [],
      agentSession: { isStreaming: false, isBashRunning: false },
    }),
    clearTabChatProjection: () => undefined,
    clearTab: async () => ({ tab }),
  } as unknown as MixCodeRuntime;
  const host = createBatchExecutorHost({
    state,
    runtime,
    tui: { requestRender: () => undefined },
  });

  await host.clearTab("s1", { systemPrompt: "You are a strict reviewer." });
  assert.equal(tab.customBasePrompt, true);
});

test("batch create rolls back state when runtime creation fails", async () => {
  const state = createInitialState("/repo");
  const runtime = {
    resolveModel: () => ({
      provider: "faux",
      id: "faux-1",
      name: "faux-1",
      api: "faux",
      contextWindow: 200_000,
      maxTokens: 1,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    createTab: async () => {
      throw new Error("create failed");
    },
  } as unknown as MixCodeRuntime;
  const host = createBatchExecutorHost({
    state,
    runtime,
    tui: { requestRender: () => undefined },
  });

  await assert.rejects(
    () => host.createNewTab({ name: "broken", prompt: "hello" }),
    /create failed/,
  );
  assert.equal(state.tabs.length, 0);
  assert.equal(state.activeTabId, "config");
});
