import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createInitialState,
  createTab,
  handleSubmittedInput,
  MixCodeRuntime,
} from "../src/index.js";

async function withRuntime(
  name: string,
  run: (runtime: MixCodeRuntime, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), name));
  try {
    await run(new MixCodeRuntime({ sessionsRoot: join(dir, "sessions") }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("clear reuses services while replacing the agent session", async () => {
  await withRuntime("mixcode-clear-reuse-services-", async (runtime) => {
    const initial = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const services = initial.services;
    const agentSession = initial.agentSession;

    const cleared = await runtime.clearTab("s1", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s1-clear",
    });

    assert.equal(cleared.services, services);
    assert.notEqual(cleared.agentSession, agentSession);
    assert.deepEqual(cleared.chat, []);
    assert.equal(runtime.getTab("s1"), undefined);
    assert.equal(runtime.getTab("s1-clear"), cleared);
  });
});

test("extension commands work after clearTab without stale ctx error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-clear-extension-cmd-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("ping", {
      description: "Ping test",
      handler: (_args, _ctx) => {
        // This calls runtime.assertActive() internally via the pi closure
        pi.sendMessage({ content: "pong", display: false });
        events.push("pong");
      },
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      extensionFactories: [extension],
    });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const cleared = await runtime.clearTab("s1", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s1-clear",
    });

    // Execute the extension command on the cleared session — should not throw stale error
    await runtime.prompt("s1-clear", "/ping");
    assert.ok(events.includes("pong"), "Extension command should execute without stale ctx error");
    // Verify no system error messages about stale ctx
    const staleErrors = cleared.chat.filter(
      (msg) => msg.role === "system" && msg.text.includes("stale"),
    );
    assert.equal(staleErrors.length, 0, `Unexpected stale errors: ${JSON.stringify(staleErrors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extension commands work after clearTab on a forked session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-fork-clear-ext-cmd-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("ping", {
      description: "Ping test",
      handler: (_args, _ctx) => {
        pi.sendMessage({ content: "pong", display: false });
        events.push("pong");
      },
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      extensionFactories: [extension],
    });
    const source = await runtime.createTab(createTab(1, "source", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.forkSession("source", "forked");
    await runtime.createTab(
      createTab(2, "forked", process.cwd(), {
        model: { ...source.tab.model },
        thinkingLevel: source.tab.thinkingLevel,
      }),
      {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: process.cwd(),
        reuseServicesFromSessionId: "source",
      },
    );

    // Clear the forked session — this disposes its runner, invalidating the shared runtime
    const cleared = await runtime.clearTab("forked", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "forked-clear",
    });

    // Extension command on cleared forked session should work
    await runtime.prompt("forked-clear", "/ping");
    assert.ok(events.includes("pong"), "Extension command should work after fork+clear");
    const staleErrors = cleared.chat.filter(
      (msg) => msg.role === "system" && msg.text.includes("stale"),
    );
    assert.equal(staleErrors.length, 0, `Unexpected stale errors: ${JSON.stringify(staleErrors)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createTab can reuse another tab's services for slash fork", async () => {
  await withRuntime("mixcode-fork-reuse-services-", async (runtime) => {
    const source = await runtime.createTab(createTab(1, "source", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.forkSession("source", "forked");
    const forkedTab = createTab(2, "forked", process.cwd(), {
      model: { ...source.tab.model },
      thinkingLevel: source.tab.thinkingLevel,
    });

    const forked = await runtime.createTab(forkedTab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      reuseServicesFromSessionId: "source",
    });

    assert.equal(forked.services, source.services);
    assert.notEqual(forked.agentSession, source.agentSession);
    assert.equal(runtime.getTab("source"), source);
    assert.equal(runtime.getTab("forked"), forked);
  });
});

test("service reuse failure falls back to fresh services with a target system message", async () => {
  await withRuntime("mixcode-reuse-fallback-", async (runtime) => {
    const source = await runtime.createTab(createTab(1, "source", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const registry = source.services.modelRegistry as unknown as {
      registerProvider: (...args: unknown[]) => unknown;
    };
    registry.registerProvider = () => {
      throw new Error("reuse boom");
    };
    await runtime.forkSession("source", "forked");

    const forked = await runtime.createTab(createTab(2, "forked", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      reuseServicesFromSessionId: "source",
    });

    assert.notEqual(forked.services, source.services);
    assert.equal(forked.tab.sessionId, "forked");
    assert.ok(
      forked.chat.some(
        (line) => line.role === "system" && line.text.includes("reuse boom"),
      ),
    );
  });
});

test("service reuse startup failure shuts down the partial fast-path session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-reuse-startup-fallback-"));
  const events: string[] = [];
  let failAfterForkStart = false;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (event, ctx) => {
      events.push(`${ctx.sessionManager?.getSessionId()}:start:${event.reason}`);
      if (ctx.sessionManager?.getSessionId() === "forked") failAfterForkStart = true;
    });
    pi.on("session_shutdown", (event, ctx) => {
      events.push(`${ctx.sessionManager?.getSessionId()}:shutdown:${event.reason}`);
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      extensionFactories: [extension],
    });
    const source = await runtime.createTab(createTab(1, "source", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const resourceLoader = source.services.resourceLoader as unknown as {
      getSkills: () => unknown;
    };
    const originalGetSkills = resourceLoader.getSkills.bind(source.services.resourceLoader);
    resourceLoader.getSkills = () => {
      if (failAfterForkStart) throw new Error("startup boom");
      return originalGetSkills();
    };
    await runtime.forkSession("source", "forked");

    const forked = await runtime.createTab(createTab(2, "forked", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      reuseServicesFromSessionId: "source",
    });

    assert.notEqual(forked.services, source.services);
    assert.ok(events.includes("forked:shutdown:new"));
    assert.equal(events.filter((event) => event === "forked:start:startup").length, 2);
    assert.ok(
      forked.chat.some(
        (line) => line.role === "system" && line.text.includes("startup boom"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reload gives one tab private fresh services after fork reuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-reload-private-services-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (event, ctx) => {
      events.push(`${ctx.sessionManager?.getSessionId()}:start:${event.reason}`);
    });
    pi.on("session_shutdown", (event, ctx) => {
      events.push(`${ctx.sessionManager?.getSessionId()}:shutdown:${event.reason}`);
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      extensionFactories: [extension],
    });
    const source = await runtime.createTab(createTab(1, "source", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.forkSession("source", "forked");
    const forked = await runtime.createTab(createTab(2, "forked", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      reuseServicesFromSessionId: "source",
    });
    assert.equal(forked.services, source.services);

    await runtime.extensionReload("forked");

    assert.notEqual(forked.services, source.services);
    assert.equal(runtime.getTab("source")?.services, source.services);
    assert.ok(events.includes("forked:shutdown:reload"));
    assert.ok(events.includes("forked:start:reload"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slash fork requests service reuse from the source tab", async () => {
  const state = createInitialState("/repo");
  const source = createTab(1, "source", "/repo", { title: "Worker" });
  state.tabs.push(source);
  state.activeTabId = "source";
  const createConfigs: unknown[] = [];
  const runtime = {
    appendSystemMessage: () => undefined,
    prompt: async () => undefined,
    getTab: () => undefined,
    forkSession: async () => undefined,
    createTab: async (_tab: unknown, config: unknown) => {
      createConfigs.push(config);
    },
    closeTab: async () => undefined,
    closeAllTabs: async () => undefined,
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    executeShellCommand: async () => undefined,
    extensionReload: async () => undefined,
    compactSession: async () => undefined,
    setExtensionEnabled: async () => undefined,
    renameSession: () => undefined,
  } as unknown as Parameters<typeof handleSubmittedInput>[1];
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/fork", tui);

  assert.equal(createConfigs.length, 1);
  assert.equal(
    (createConfigs[0] as { reuseServicesFromSessionId?: string }).reuseServicesFromSessionId,
    "source",
  );
});

test("reload keeps derived tab fields bound to the new session", async () => {
  // The session-rebind sites set agentSession/services plus two DERIVED fields:
  // agent (= agentSession.agent) and extensionManagerEntries (= entries for services).
  // If a rebind path forgets a derived field, it silently desyncs from its source.
  await withRuntime("mixcode-reload-rebind-invariant-", async (runtime, dir) => {
    const tab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.equal(tab.agent, tab.agentSession.agent, "agent bound after create");

    // extensionReload rebinds via runtime-lifecycle.ts.
    await runtime.extensionReload("s1");
    const afterReload = runtime.getTab("s1");
    assert.ok(afterReload);
    assert.equal(afterReload.agent, afterReload.agentSession.agent, "agent bound after reload");

    // updateTabWorkdir rebinds via runtime.ts using a fresh services instance.
    const nextWorkdir = join(dir, "sub");
    await mkdir(nextWorkdir, { recursive: true });
    const beforeServices = afterReload.services;
    await runtime.updateTabWorkdir("s1", nextWorkdir);
    const afterWorkdir = runtime.getTab("s1");
    assert.ok(afterWorkdir);
    assert.notEqual(afterWorkdir.services, beforeServices, "services replaced on workdir change");
    assert.equal(afterWorkdir.agent, afterWorkdir.agentSession.agent, "agent bound after workdir");
  });
});
