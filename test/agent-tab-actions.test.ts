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
import { modelToRef, registerModels } from "../src/core/models.js";

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
  test(`batch ${extension} sends unknown slash input and paths through the prompt pipeline`, async () => {
    await withBatchRuntime(async (runtime, state, dir) => {
      const host = createBatchExecutorHost({ state, runtime, tui: { requestRender() {} } });
      const prompts = ["/nfs/home/sessions/missing.jsonl", "/unknown first\n  second", "/"];
      const scriptPath = path.join(dir, `slash-input.${extension}`);
      const requests = prompts.map((prompt, index) =>
        extension === "lua"
          ? `mixcode.open_tab({ name = "slash-${index}", prompt = ${JSON.stringify(prompt)} })`
          : `mixcode.openTab(${JSON.stringify({ name: `slash-${index}`, prompt })});`,
      );
      await Bun.write(
        scriptPath,
        extension === "lua"
          ? requests.join("\n")
          : `export default (mixcode) => {\n${requests.join("\n")}\n};`,
      );
      const plan = await loadBatchRequests(scriptPath, contextFromState(state));
      await applyBatchRequests(plan.requests, host);
      assert.deepEqual(
        state.tabs.map((tab) =>
          runtime
            .getTab(tab.sessionId)!
            .agentSession.messages.filter((message) => message.role === "user")
            .map((message) => message.content),
        ),
        prompts.map((prompt) => [[{ type: "text", text: prompt }]]),
      );
    });
  });

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

test("batch context limits apply without prompts across reuse modes and remain isolated", async () => {
  await withBatchRuntime(async (runtime, state) => {
    const host = createBatchExecutorHost({ state, runtime, tui: { requestRender() {} } });
    await applyBatchRequests([{ name: "peer" }], host);
    const peer = runtime.getTab(state.tabs[0]!.sessionId)!;
    const baseline = peer.agentSession.settingsManager.getCompactionSettings();

    await applyBatchRequests([{ name: "limited", contextLimit: 8_000 }], host);
    const tab = state.tabs[1]!;
    const originalId = tab.sessionId;
    const session = runtime.getTab(originalId)!.agentSession;
    assert.deepEqual(
      {
        ui: tab.contextLimit,
        window: session.model?.contextWindow,
        overridden: tab.contextLimitOverridden,
      },
      { ui: 8_000, window: 8_000, overridden: true },
    );
    assert.deepEqual(session.settingsManager.getCompactionSettings(), {
      ...baseline,
      reserveTokens: 800,
      keepRecentTokens: 2_000,
    });

    await applyBatchRequests([{ name: "limited", contextLimit: 32_000 }], host);
    await applyBatchRequests([{ name: "limited" }], host);
    assert.equal(tab.contextLimit, 32_000);
    assert.equal(session.model?.contextWindow, 32_000);

    await applyBatchRequests([{ name: "limited", mode: "clear", contextLimit: 64_000 }], host);
    assert.equal(tab.sessionId, originalId);
    assert.equal(session.model?.contextWindow, 64_000);
    assert.deepEqual(session.settingsManager.getCompactionSettings(), {
      ...baseline,
      reserveTokens: 6_400,
      keepRecentTokens: 16_000,
    });

    await applyBatchRequests([{ name: "limited", contextLimit: "reset" }], host);
    assert.equal(tab.contextLimitOverridden, false);
    assert.equal(session.model?.contextWindow, MIXCODE_FAUX_MODEL.contextWindow);
    assert.deepEqual(session.settingsManager.getCompactionSettings(), baseline);

    await applyBatchRequests([{ name: "limited", contextLimit: 400_000 }], host);
    assert.equal(session.model?.contextWindow, 400_000);
    assert.equal(tab.model.contextWindow, MIXCODE_FAUX_MODEL.contextWindow);
    assert.equal(tab.toast?.type, "warning");
    assert.match(tab.toast!.message, /exceeds model capacity/);

    await applyBatchRequests([{ name: "limited", mode: "delete", contextLimit: 16_000 }], host);
    const replacement = state.tabs.find((item) => item.title === "limited")!;
    assert.notEqual(replacement.sessionId, originalId);
    assert.equal(replacement.contextLimit, 16_000);
    assert.equal(runtime.getTab(replacement.sessionId)!.agentSession.model?.contextWindow, 16_000);
    assert.deepEqual(peer.agentSession.settingsManager.getCompactionSettings(), baseline);
    assert.equal(peer.agentSession.model?.contextWindow, MIXCODE_FAUX_MODEL.contextWindow);
    assert.equal(peer.tab.contextLimit, MIXCODE_FAUX_MODEL.contextWindow);
  });
});

for (const extension of ["lua", "ts"]) {
  test(`batch ${extension} applies each limit after model selection and before provider input`, async () => {
    const observed: Array<{ model: string; window: number }> = [];
    await withBatchRuntime(
      async (runtime, state, dir) => {
        const firstModel = {
          ...MIXCODE_FAUX_MODEL,
          provider: "batch-context-test",
          api: "batch-context-test",
        };
        const secondModel = { ...firstModel, id: "faux-second" };
        registerModels([firstModel, secondModel]);
        state.model = modelToRef(firstModel);
        state.availableModels = [state.model, modelToRef(secondModel)];
        const source =
          extension === "lua"
            ? `mixcode.open_tab({ name = "ordered", context_limit = "32k", prompt = "first" })
           mixcode.open_tab({ name = "ordered", model = "batch-context-test/faux-second", context_limit = 64000, prompt = "second" })
           mixcode.open_tab({ name = "ordered", prompt = "keep" })
           mixcode.open_tab({ name = "ordered", context_limit = "reset", prompt = "reset" })
           mixcode.open_tab({ name = "ordered", context_limit = 32000 })
           mixcode.open_tab({ name = "ordered", model = "batch-context-test/faux-1", prompt = "model default" })`
            : `export default (mixcode) => {
             mixcode.openTab({ name: "ordered", contextLimit: "32k", prompt: "first" });
             mixcode.openTab({ name: "ordered", model: "batch-context-test/faux-second", contextLimit: 64000, prompt: "second" });
             mixcode.openTab({ name: "ordered", prompt: "keep" });
             mixcode.openTab({ name: "ordered", contextLimit: "reset", prompt: "reset" });
             mixcode.openTab({ name: "ordered", contextLimit: 32000 });
             mixcode.openTab({ name: "ordered", model: "batch-context-test/faux-1", prompt: "model default" });
           };`;
        const scriptPath = path.join(dir, `context-order.${extension}`);
        await Bun.write(scriptPath, source);
        const plan = await loadBatchRequests(scriptPath, contextFromState(state));
        await applyBatchRequests(
          plan.requests,
          createBatchExecutorHost({ state, runtime, tui: { requestRender() {} } }),
        );
        assert.deepEqual(observed, [
          { model: "faux-1", window: 32_000 },
          { model: "faux-second", window: 64_000 },
          { model: "faux-second", window: 64_000 },
          { model: "faux-second", window: 200_000 },
          { model: "faux-1", window: 200_000 },
        ]);
      },
      {
        streamFn: (model, context, options) => {
          observed.push({ model: model.id, window: model.contextWindow });
          return mixcodeFauxStream(model, context, options);
        },
      },
    );
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
