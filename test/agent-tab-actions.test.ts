import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createBatchExecutorHost } from "../src/cli/batch-host.js";
import { applyBatchRequests, contextFromState, loadBatchRequests } from "../src/core/batch-lua.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { modelToRef } from "../src/core/models.js";

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

async function withBatchRuntime(
  run: (
    runtime: MixCodeRuntime,
    state: ReturnType<typeof createInitialState>,
    dir: string,
  ) => Promise<void>,
  options: ConstructorParameters<typeof MixCodeRuntime>[0] = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-host-"));
  const runtime = new MixCodeRuntime({ ...options, sessionsRoot: path.join(dir, "sessions") });
  try {
    await run(runtime, createInitialState(dir), dir);
  } finally {
    await runtime.closeAllTabs();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const extension of ["lua", "ts"]) {
  test(`batch ${extension} clear keeps identity and history across repeated lookup`, async () => {
    await withBatchRuntime(async (runtime, state, dir) => {
      const host = createBatchExecutorHost({ state, runtime, tui: { requestRender() {} } });
      await applyBatchRequests(
        [{ name: "reviewer", prompt: "old context", systemPrompt: "Original identity" }],
        host,
      );
      const tab = state.tabs[0]!;
      const sessionId = tab.sessionId;
      const original = runtime.getTab(sessionId)!;
      const sessionFile = original.session.getSessionFile()!;
      const oldEntries = original.session.getEntries();
      const oldMessages = original.agentSession.agent.state.messages;
      assert.deepEqual(
        oldMessages.filter((message) => message.role === "user").map((message) => message.content),
        [[{ type: "text", text: "old context" }]],
      );
      const activeId = state.activeTabId;
      const scriptPath = path.join(dir, `clear.${extension}`);
      await Bun.write(
        scriptPath,
        extension === "lua"
          ? 'mixcode.open_tab({ name = "reviewer", mode = "clear" })'
          : 'export default (mixcode) => mixcode.openTab({ name: "reviewer", mode: "clear" });',
      );
      const plan = await loadBatchRequests(scriptPath, contextFromState(state));
      for (let iteration = 0; iteration < 2; iteration++) {
        tab.chatScrollOffset = 8;
        tab.chatScrollAnchorEntryId = "old-entry";
        tab.chatScrollAnchorIndex = 4;
        tab.chatScrollAnchorText = "old context";
        tab.currentContextTokens = 1234;
        await applyBatchRequests(plan.requests, host);
        assert.deepEqual(
          state.tabs.map(({ sessionId, title }) => ({ sessionId, title })),
          [{ sessionId, title: "reviewer" }],
        );
        assert.equal(state.activeTabId, activeId);
        const current = runtime.getTab(sessionId)!;
        assert.equal(current.session.getSessionId(), sessionId);
        assert.equal(current.session.getSessionFile(), sessionFile);
        assert.equal(current.session.getSessionName(), "reviewer");
        assert.equal(current.session.getLeafId(), null);
        assert.deepEqual(current.session.getEntries(), oldEntries);
        assert.deepEqual(current.agentSession.agent.state.messages, []);
        assert.deepEqual(current.chat, []);
        assert.match(current.agentSession.agent.state.systemPrompt, /Original identity/);
        assert.equal(tab.customBasePrompt, true);
        assert.equal(tab.workdir, dir);
        assert.equal(tab.chatScrollOffset, 0);
        assert.equal(tab.chatScrollAnchorEntryId, undefined);
        assert.equal(tab.chatScrollAnchorIndex, undefined);
        assert.equal(tab.chatScrollAnchorText, undefined);
        assert.equal(tab.currentContextTokens, undefined);
      }
      state.availableModels.push({ ...state.model, modelId: "faux-2", displayName: "faux/faux-2" });
      await applyBatchRequests(
        [
          {
            name: "reviewer",
            mode: "clear",
            model: "faux/faux-2",
            thinking: "low",
            prompt: "fresh context",
          },
          { name: "reviewer", mode: "clear", prompt: "second prompt" },
        ],
        host,
      );
      const current = runtime.getTab(sessionId)!;
      assert.equal(current.tab.thinkingLevel, "low");
      assert.equal(current.agentSession.thinkingLevel, "low");
      assert.equal(current.tab.model.modelId, "faux-2");
      assert.equal(current.agentSession.model?.id, "faux-2");
      assert.deepEqual(
        current.agentSession.agent.state.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
        [[{ type: "text", text: "fresh context" }], [{ type: "text", text: "second prompt" }]],
      );
      const persisted = SessionManager.open(sessionFile);
      assert.equal(persisted.getSessionId(), sessionId);
      assert.equal(persisted.getSessionName(), "reviewer");
      assert.deepEqual(
        persisted
          .getEntries()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "user"
              ? [entry.message.content]
              : [],
          ),
        [
          [{ type: "text", text: "old context" }],
          [{ type: "text", text: "fresh context" }],
          [{ type: "text", text: "second prompt" }],
        ],
      );
      assert.deepEqual(
        persisted
          .buildSessionContext()
          .messages.filter((message) => message.role === "user")
          .map((message) => message.content),
        [[{ type: "text", text: "fresh context" }], [{ type: "text", text: "second prompt" }]],
      );
    });
  });
}

test("batch clear surfaces streaming reset failure without clearing the view", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await withBatchRuntime(
    async (runtime, state) => {
      const host = createBatchExecutorHost({ state, runtime, tui: { requestRender() {} } });
      const model = { ...MIXCODE_FAUX_MODEL, provider: "batch-blocked", api: "batch-blocked" };
      const tab = createTab(1, "busy-session", state.workdir, {
        title: "reviewer",
        model: modelToRef(model),
      });
      state.tabs.push(tab);
      await runtime.createTab(tab, {
        workdir: state.workdir,
        systemPrompt: "system",
        thinkingLevel: "off",
        model,
      });
      const sessionId = tab.sessionId;
      const pending = host.submitInput(sessionId, "busy");
      try {
        await entered.promise;
        tab.chatScrollOffset = 7;
        tab.chatScrollAnchorText = "still visible";
        await assert.rejects(
          () => applyBatchRequests([{ name: "reviewer", mode: "clear" }], host),
          {
            message: "Error: Cannot reset a session while it is streaming",
          },
        );
        assert.equal(tab.sessionId, sessionId);
        assert.equal(tab.title, "reviewer");
        assert.equal(tab.chatScrollOffset, 7);
        assert.equal(tab.chatScrollAnchorText, "still visible");
      } finally {
        release.resolve();
        await pending;
      }
    },
    {
      streamFn: async (model, context, options) => {
        entered.resolve();
        await release.promise;
        return mixcodeFauxStream(model, context, options);
      },
    },
  );
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

test("batch clear with system_prompt fails before changing an existing runtime or creating tabs", async () => {
  await withBatchRuntime(async (runtime, state) => {
    const host = createBatchExecutorHost({ state, runtime, tui: { requestRender() {} } });
    await applyBatchRequests([{ name: "reviewer", prompt: "keep context" }], host);
    const tab = state.tabs[0]!;
    const original = runtime.getTab(tab.sessionId)!;
    const entries = original.session.getEntries();
    const messages = original.agentSession.agent.state.messages;
    const sessionId = tab.sessionId;
    for (const name of ["reviewer", "missing"]) {
      await assert.rejects(
        () =>
          applyBatchRequests(
            [
              { name: "reviewer", mode: "clear" },
              { name: "not-created" },
              { name, mode: "clear", systemPrompt: "" },
            ],
            host,
          ),
        { message: /^Error:.*system_prompt.*mode="clear"/ },
      );
      assert.deepEqual(
        state.tabs.map((item) => item.sessionId),
        [sessionId],
      );
      assert.equal(tab.title, "reviewer");
      assert.deepEqual(original.session.getEntries(), entries);
      assert.deepEqual(original.agentSession.agent.state.messages, messages);
    }
  });
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
  assert.equal(state.activeTabId, "home");
});
