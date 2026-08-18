import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  configureOpenTabsPath,
  createInitialState,
  createTab,
  handleSubmittedInput,
  MixCodeRuntime,
  openTabsFile,
} from "./helpers/mixcode.js";

async function withRuntime(
  name: string,
  run: (runtime: MixCodeRuntime, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), name));
  const runtime = new MixCodeRuntime({ sessionsRoot: path.join(dir, "sessions") });
  try {
    await run(runtime, dir);
  } finally {
    try {
      await runtime.closeAllTabs();
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
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
    assert.match(cleared.tab.startupSummary ?? "", /\[Context\]/);
    assert.equal(
      cleared.chat.some((line) => line.role === "user" || line.role === "assistant"),
      false,
    );
    assert.equal(runtime.getTab("s1"), undefined);
    assert.equal(runtime.getTab("s1-clear"), cleared);
  });
});

test("clear rebuilds services when rebuildServices is set for a new base prompt", async () => {
  await withRuntime("mixcode-clear-rebuild-services-", async (runtime) => {
    const initial = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "old base identity",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const services = initial.services;
    assert.match(initial.agentSession.agent.state.systemPrompt ?? "", /old base identity/);

    const cleared = await runtime.clearTab("s1", {
      systemPrompt: "new base identity",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s1-clear",
      rebuildServices: true,
    });

    assert.notEqual(cleared.services, services);
    assert.match(cleared.agentSession.agent.state.systemPrompt ?? "", /new base identity/);
    assert.match(cleared.agentSession.agent.state.systemPrompt ?? "", /Available tools:/);
  });
});

test("clear drops session name and resets tab title like Pi /new", async () => {
  await withRuntime("mixcode-clear-session-name-", async (runtime) => {
    const initial = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtime.renameSession("s1", "My Work");
    initial.tab.title = "My Work";

    const cleared = await runtime.clearTab("s1", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s1-clear",
    });

    assert.equal(
      cleared.chat.some((line) => line.role === "user" || line.role === "assistant"),
      false,
    );
    assert.equal(cleared.session.getSessionName(), undefined);
    assert.equal(cleared.tab.title, "Agent-01");
  });
});

test("extension commands work after clearTab without stale ctx error", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clear-extension-cmd-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("ping", {
      description: "Ping test",
      handler: () => {
        pi.sendMessage({ content: "pong", display: false });
        events.push("pong");
      },
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
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

    await runtime.prompt("s1-clear", "/ping");
    assert.ok(events.includes("pong"));
    assert.equal(
      cleared.chat.filter((msg) => msg.role === "system" && msg.text.includes("stale")).length,
      0,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("extension commands work after clearTab on a forked session", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-fork-clear-ext-cmd-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("ping", {
      description: "Ping test",
      handler: () => {
        pi.sendMessage({ content: "pong", display: false });
        events.push("pong");
      },
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
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

    const cleared = await runtime.clearTab("forked", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "forked-clear",
    });

    await runtime.prompt("forked-clear", "/ping");
    assert.ok(events.includes("pong"));
    assert.equal(
      cleared.chat.filter((msg) => msg.role === "system" && msg.text.includes("stale")).length,
      0,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
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
    const forked = await runtime.createTab(
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

    assert.equal(forked.services, source.services);
    assert.notEqual(forked.agentSession, source.agentSession);
    assert.equal(runtime.getTab("source"), source);
    assert.equal(runtime.getTab("forked"), forked);
  });
});

test("slash fork keeps and persists the fork suffix for a named source tab", async () => {
  await withRuntime("mixcode-fork-named-title-", async (runtime, dir) => {
    configureOpenTabsPath(openTabsFile(dir));
    try {
      const state = createInitialState(dir);
      const source = createTab(1, "source", dir, { title: "Worker" });
      state.tabs.push(source);
      state.activeTabId = source.sessionId;
      await runtime.createTab(source, {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: dir,
      });
      runtime.renameSession(source.sessionId, source.title);

      await handleSubmittedInput(state, runtime, "/fork", {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      });

      const forked = state.tabs[1]!;
      assert.equal(forked.title, "Worker-fork");
      assert.equal(runtime.getTab(forked.sessionId)?.session.getSessionName(), "Worker-fork");

      await runtime.closeAllTabs();
      const reopenedRuntime = new MixCodeRuntime({ sessionsRoot: path.join(dir, "sessions") });
      try {
        const reopenedTab = createTab(1, forked.sessionId, dir);
        await reopenedRuntime.createTab(reopenedTab, {
          systemPrompt: "system",
          thinkingLevel: "medium",
          workdir: dir,
        });
        assert.equal(reopenedTab.title, "Worker-fork");
      } finally {
        await reopenedRuntime.closeAllTabs();
      }
    } finally {
      configureOpenTabsPath(undefined);
    }
  });
});

test("slash fork keeps the fork suffix for an unnamed source tab", async () => {
  await withRuntime("mixcode-fork-unnamed-title-", async (runtime, dir) => {
    configureOpenTabsPath(openTabsFile(dir));
    try {
      const state = createInitialState(dir);
      const source = createTab(1, "source", dir);
      state.tabs.push(source);
      state.activeTabId = source.sessionId;
      await runtime.createTab(source, {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: dir,
      });

      await handleSubmittedInput(state, runtime, "/fork", {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      });

      const forked = state.tabs[1]!;
      assert.equal(forked.title, "Agent-01-fork");
      assert.equal(runtime.getTab(forked.sessionId)?.session.getSessionName(), "Agent-01-fork");
    } finally {
      configureOpenTabsPath(undefined);
    }
  });
});

test("service reuse failure falls back to fresh services with a target system message", async () => {
  await withRuntime("mixcode-reuse-fallback-", async (runtime) => {
    const source = await runtime.createTab(createTab(1, "source", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const registry = source.services.modelRuntime as unknown as {
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
      forked.chat.some((line) => line.role === "system" && line.text.includes("reuse boom")),
    );
  });
});

test("service reuse startup failure falls back with a system message", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-reuse-startup-fallback-"));
  let failAfterForkStart = false;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.sessionManager?.getSessionId() === "forked") failAfterForkStart = true;
    });
  };
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
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
    assert.ok(
      forked.chat.some((line) => line.role === "system" && line.text.includes("startup boom")),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("reload gives one tab private fresh services after fork reuse", async () => {
  await withRuntime("mixcode-reload-private-services-", async (runtime) => {
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
  });
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

test("reload recomputes the startup header and keeps conversation", async () => {
  await withRuntime("mixcode-reload-startup-summary-", async (runtime) => {
    const tab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.match(tab.tab.startupSummary ?? "", /\[Context\]/);

    await runtime.prompt("s1", "hello");
    assert.ok(
      runtime.getTab("s1")?.chat.some((line) => line.role === "user" && line.text === "hello"),
    );

    await runtime.extensionReload("s1");
    const afterReload = runtime.getTab("s1");
    assert.ok(afterReload);
    assert.ok(
      afterReload.chat.some((line) => line.role === "user" && line.text === "hello"),
    );
    assert.match(afterReload.tab.startupSummary ?? "", /\[Context\]/);
  });
});
