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
      handler: async () => {
        pi.sendMessage({ customType: "ping-ack", content: "pong", display: false });
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
      handler: async () => {
        pi.sendMessage({ customType: "ping-ack", content: "pong", display: false });
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

test("a forked tab never shares services with its still-live source tab", async () => {
  await withRuntime("mixcode-fork-private-services-", async (runtime) => {
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
      },
    );

    assert.notEqual(forked.services, source.services);
    assert.notEqual(forked.services.settingsManager, source.services.settingsManager);
    assert.notEqual(forked.agentSession, source.agentSession);
    assert.equal(runtime.getTab("source"), source);
    assert.equal(runtime.getTab("forked"), forked);
  });
});

test("slash fork isolates the extension event bus from the source tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-fork-bus-isolation-"));
  const CHANNEL = "mpi-test:fork-bus";
  const deliveries: string[] = [];
  let instanceSeq = 0;
  // One factory invocation per bound session: instanceId identifies which
  // session's extension closure received the event.
  const extension: ExtensionFactory = (pi) => {
    const instanceId = ++instanceSeq;
    pi.events.on(CHANNEL, (payload) => {
      deliveries.push(`${instanceId}<-${(payload as { from: number }).from}`);
    });
    pi.registerCommand("emit-bus-ping", {
      description: "Emit a test event on the session event bus",
      handler: async () => {
        pi.events.emit(CHANNEL, { from: instanceId });
      },
    });
  };
  try {
    configureOpenTabsPath(openTabsFile(dir));
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      extensionFactories: [extension],
    });
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
      const sourceInstanceId = instanceSeq;

      await handleSubmittedInput(state, runtime, "/fork", {
        requestRender: () => undefined,
        showOverlay: () => ({}) as never,
      });
      const forked = state.tabs[1]!;
      assert.ok(runtime.getTab(forked.sessionId));

      await runtime.prompt(source.sessionId, "/emit-bus-ping");
      await Bun.sleep(0);

      assert.deepEqual(deliveries, [`${sourceInstanceId}<-${sourceInstanceId}`]);
    } finally {
      await runtime.closeAllTabs();
    }
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
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
    const previousServices = source.services;
    const registry = previousServices.modelRuntime as unknown as {
      registerProvider: (...args: unknown[]) => unknown;
    };
    registry.registerProvider = () => {
      throw new Error("reuse boom");
    };

    // /clear carries services across a session replacement inside one tab.
    const cleared = await runtime.clearTab("source", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "source-clear",
    });

    assert.notEqual(cleared.services, previousServices);
    assert.equal(cleared.tab.sessionId, "source-clear");
    assert.ok(
      cleared.chat.some((line) => line.role === "system" && line.text.includes("reuse boom")),
    );
  });
});

test("service reuse startup failure falls back with a system message", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-reuse-startup-fallback-"));
  let failAfterClearStart = false;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.sessionManager?.getSessionId() === "source-clear") failAfterClearStart = true;
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
      if (failAfterClearStart) throw new Error("startup boom");
      return originalGetSkills();
    };
    const previousServices = source.services;

    const cleared = await runtime.clearTab("source", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "source-clear",
    });

    assert.notEqual(cleared.services, previousServices);
    assert.ok(
      cleared.chat.some((line) => line.role === "system" && line.text.includes("startup boom")),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("reload recomputes the startup header and keeps conversation", async () => {
  await withRuntime("mixcode-reload-startup-summary-", async (runtime) => {
    const tab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.match(tab.tab.startupSummary ?? "", /\[Context\]/);
    const servicesBeforeReload = tab.services;

    await runtime.prompt("s1", "hello");
    assert.ok(
      runtime.getTab("s1")?.chat.some((line) => line.role === "user" && line.text === "hello"),
    );

    await runtime.extensionReload("s1");
    const afterReload = runtime.getTab("s1");
    assert.ok(afterReload);
    assert.ok(afterReload.chat.some((line) => line.role === "user" && line.text === "hello"));
    assert.match(afterReload.tab.startupSummary ?? "", /\[Context\]/);
    // Reload swaps in fresh services; the disposed session's runtime must not
    // survive into the reloaded tab.
    assert.notEqual(afterReload.services, servicesBeforeReload);
  });
});
