import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { configureOpenTabsPath, readOpenTabs, writeOpenTabs } from "../src/core/open-tabs-store.js";
import { startPeerTabSync } from "../src/core/peer-tab-sync.js";
import { bindRuntimeRendering } from "../src/ui/app-runtime.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import { closeExistingAgentTab, openExistingAgentTab } from "../src/ui/agent-tab-actions.js";

test("extension handoff keeps the new task, focus, and shared identity across reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-handoff-identity-"));
  const state = createInitialState(root);
  const tab = createTab(1, "source", root);
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  state.recentAgentTabIds = [tab.sessionId];
  const openTabsPath = path.join(root, "open_tabs.json");
  configureOpenTabsPath(openTabsPath);
  writeOpenTabs(openTabsPath, [tab.sessionId]);
  const requests: string[][] = [];
  let targetId: string | undefined;
  let atHandoff: { active: string; shared: string[] } | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.on("context", (event) => {
      requests.push(
        event.messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          ),
      );
    });
    pi.registerCommand("handoff", {
      handler: async (_args, ctx) => {
        await ctx.newSession({
          withSession: async (replacement) => {
            targetId = replacement.sessionManager.getSessionId();
            atHandoff = { active: state.activeTabId, shared: readOpenTabs(openTabsPath) };
            await replacement.sendUserMessage("TASK: export-report");
          },
        });
      },
    });
  };
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    extensionFactories: [extension],
  });
  const unbind = bindRuntimeRendering(runtime, { requestRender() {} }, state);
  let sync: ReturnType<typeof startPeerTabSync> | undefined;
  try {
    await runtime.createTab(tab, {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    await runtime.prompt(tab.sessionId, "TASK: repair-login");
    sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: root,
      workdir: root,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => state.tabs.map((item) => item.sessionId),
      openTab: async (candidate) => {
        await openExistingAgentTab(state, runtime, {
          ...candidate,
          runtimeModel: MIXCODE_FAUX_MODEL,
        });
      },
      closeTab: (sessionId) =>
        closeExistingAgentTab(state, runtime, sessionId, { publishClose: false }),
      loadStatus: async () => ({ instances: [] }),
      onError: (error) => {
        throw error;
      },
    });
    await sync.reconcileNow();
    await runtime.prompt(tab.sessionId, "/handoff");
    assert.ok(targetId, "the replacement callback must execute");
    for (let cycle = 0; cycle < 3; cycle++) await sync.reconcileNow();
    await runtime.prompt(state.activeTabId, "continue");
    assert.deepEqual(requests.at(-1), ["TASK: export-report", "continue"]);
    assert.deepEqual(atHandoff, { active: targetId, shared: [targetId] });
    assert.equal(state.activeTabId, targetId);
    assert.deepEqual(
      state.tabs.map((item) => item.sessionId),
      [targetId],
    );
    assert.deepEqual(state.recentAgentTabIds, [targetId]);
    assert.deepEqual(readOpenTabs(openTabsPath), [targetId]);
  } finally {
    sync?.dispose();
    unbind();
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const operation of ["new", "switch", "fork", "import"] as const) {
  for (const focus of ["source", "home", "other"] as const) {
    test(`${operation} replacement preserves tab order and ${focus} focus`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-replacement-focus-"));
      const state = createInitialState(root);
      const tabs = ["before", "source", "other"].map((id, index) => createTab(index + 1, id, root));
      state.tabs = tabs;
      state.activeTabId = focus;
      const recents =
        focus === "other" ? ["other", "source", "before"] : ["source", "other", "before"];
      state.recentAgentTabIds = [...recents];
      const openTabsPath = path.join(root, "open_tabs.json");
      configureOpenTabsPath(openTabsPath);
      writeOpenTabs(
        openTabsPath,
        tabs.map((tab) => tab.sessionId),
      );
      const runtime = new MixCodeRuntime({
        sessionsRoot: path.join(root, "sessions"),
        agentDir: path.join(root, "agent"),
      });
      const persisted: string[] = [];
      const unbind = bindRuntimeRendering(runtime, { requestRender() {} }, state, (next) => {
        persisted.push(next.activeTabId);
      });
      try {
        for (const tab of tabs)
          await runtime.createTab(tab, {
            workdir: root,
            systemPrompt: "test",
            model: MIXCODE_FAUX_MODEL,
          });
        const source = runtime.getTab("source")!;
        const originalFile = source.session.getSessionFile()!;
        await runtime.prompt("source", "source task");
        const userId = source.session
          .getBranch()
          .find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
        const target = await runtime.forkSession("source", "target");
        let targetFile = target.getSessionFile()!;
        if (operation === "import") {
          const external = path.join(root, "external");
          await fs.mkdir(external);
          const moved = path.join(external, path.basename(targetFile));
          await fs.rename(targetFile, moved);
          targetFile = moved;
        }
        let callbackId: string | undefined;
        const withSession = async (ctx: ExtensionContext) => {
          callbackId = ctx.sessionManager.getSessionId();
          assert.deepEqual(readOpenTabs(openTabsPath), ["before", callbackId, "other"]);
          assert.equal(state.activeTabId, focus === "source" ? callbackId : focus);
        };
        const result =
          operation === "new"
            ? await runtime.extensionNewSession("source", { withSession })
            : operation === "switch"
              ? await runtime.extensionSwitchSession("source", targetFile, { withSession })
              : operation === "fork"
                ? await runtime.extensionFork("source", userId, { withSession })
                : await runtime.importFromJsonl("source", targetFile);
        assert.equal(result.cancelled, false);
        const newId = source.tab.sessionId;
        assert.notEqual(newId, "source");
        assert.equal(runtime.getTab("source"), undefined);
        assert.equal(runtime.getTab(newId), source);
        if (operation !== "import") assert.equal(callbackId, newId);
        assert.deepEqual(
          state.tabs.map((tab) => tab.sessionId),
          ["before", newId, "other"],
        );
        assert.deepEqual(readOpenTabs(openTabsPath), ["before", newId, "other"]);
        assert.equal(state.activeTabId, focus === "source" ? newId : focus);
        assert.deepEqual(
          state.recentAgentTabIds,
          recents.map((id) => (id === "source" ? newId : id)),
        );
        assert.equal(persisted.at(-1), state.activeTabId);
        await fs.access(originalFile);
        await fs.access(source.session.getSessionFile()!);
      } finally {
        unbind();
        configureOpenTabsPath(undefined);
        await runtime.closeAllTabs();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("cancelled replacements do not publish an identity or invalidate the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-replacement-cancel-"));
  const file = path.join(root, "open_tabs.json");
  configureOpenTabsPath(file);
  writeOpenTabs(file, ["source"]);
  const originalSnapshot = await Bun.file(file).text();
  let callbacks = 0;
  let commits = 0;
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    extensionFactories: [
      (pi) => {
        pi.on("session_before_switch", () => ({ cancel: true }));
        pi.on("session_before_fork", () => ({ cancel: true }));
      },
    ],
  });
  runtime.onChange((event) => {
    if (event.type === "session_replaced") commits++;
  });
  try {
    const tab = await runtime.createTab(createTab(1, "source", root), {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    await runtime.prompt("source", "original task");
    const userId = tab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
    const target = await runtime.forkSession("source", "target");
    const withSession = async () => {
      callbacks++;
    };
    assert.deepEqual(await runtime.extensionNewSession("source", { withSession }), {
      cancelled: true,
    });
    assert.deepEqual(
      await runtime.extensionSwitchSession("source", target.getSessionFile()!, { withSession }),
      { cancelled: true },
    );
    assert.deepEqual(await runtime.extensionFork("source", userId, { withSession }), {
      cancelled: true,
    });
    assert.deepEqual(await runtime.importFromJsonl("source", target.getSessionFile()!), {
      cancelled: true,
    });
    assert.equal(await Bun.file(file).text(), originalSnapshot);
    assert.equal(callbacks, 0);
    assert.equal(commits, 0);
    assert.equal(tab.agentSession.sessionId, "source");
    await runtime.prompt("source", "continue");
    assert.ok(tab.chat.some((line) => line.text === "original task"));
  } finally {
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a corrupt shared snapshot rejects replacement before source shutdown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-replacement-preflight-"));
  const file = path.join(root, "open_tabs.json");
  configureOpenTabsPath(file);
  writeOpenTabs(file, ["source"]);
  let shutdowns = 0;
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    extensionFactories: [
      (pi) => {
        pi.on("session_shutdown", () => {
          shutdowns++;
        });
      },
    ],
  });
  try {
    const source = await runtime.createTab(createTab(1, "source", root), {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    await Bun.write(file, "{broken");
    await assert.rejects(runtime.extensionNewSession("source"), SyntaxError);
    assert.equal(shutdowns, 0);
    assert.equal(source.agentSession.sessionId, "source");
    assert.equal(await Bun.file(file).text(), "{broken");
    await runtime.prompt("source", "source still accepts input");
    assert.ok(source.chat.some((line) => line.text === "source still accepts input"));
  } finally {
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed shared publication restores the source runtime and does not run the handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-replacement-publish-failure-"));
  const file = path.join(root, "open_tabs.json");
  configureOpenTabsPath(file);
  writeOpenTabs(file, ["source"]);
  const liveSessions = new Set<string>();
  let callbackCalled = false;
  let commits = 0;
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    extensionFactories: [
      (pi) => {
        pi.on("session_start", async (event, ctx) => {
          liveSessions.add(ctx.sessionManager.getSessionId());
          if (event.reason === "new") {
            await fs.rename(file, `${file}.previous`);
            await fs.mkdir(file);
          }
        });
        pi.on("session_shutdown", (_event, ctx) => {
          liveSessions.delete(ctx.sessionManager.getSessionId());
        });
      },
    ],
  });
  runtime.onChange((event) => {
    if (event.type === "session_replaced") commits++;
  });
  try {
    const source = await runtime.createTab(createTab(1, "source", root), {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    await runtime.prompt("source", "original task");
    const originalFile = source.session.getSessionFile()!;
    await assert.rejects(
      runtime.extensionNewSession("source", {
        withSession: async () => {
          callbackCalled = true;
        },
      }),
      /EISDIR/,
    );
    assert.equal(callbackCalled, false);
    assert.equal(commits, 0);
    assert.equal(source.tab.sessionId, "source");
    assert.equal(source.agentSession.sessionId, "source");
    assert.equal(source.session.getSessionFile(), originalFile);
    assert.deepEqual([...liveSessions], ["source"]);
    await runtime.prompt("source", "continue");
    assert.ok(source.chat.some((line) => line.role === "user" && line.text === "original task"));
  } finally {
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI import cancellation never exposes an uncommitted target identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-import-cli-cancel-"));
  const file = path.join(root, "open_tabs.json");
  configureOpenTabsPath(file);
  writeOpenTabs(file, ["source"]);
  const state = createInitialState(root);
  const tab = createTab(1, "source", root);
  state.tabs = [tab];
  state.activeTabId = "source";
  let beforeSwitch: { active: string; shared: string[]; source: string } | undefined;
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    extensionFactories: [
      (pi) => {
        pi.on("session_before_switch", (_event, ctx) => {
          beforeSwitch = {
            active: state.activeTabId,
            shared: readOpenTabs(file),
            source: ctx.sessionManager.getSessionId(),
          };
          return { cancel: true };
        });
      },
    ],
  });
  const tui = {
    requestRender() {},
    showOverlay() {
      throw new Error("Unexpected error overlay");
    },
  };
  const unbind = bindRuntimeRendering(runtime, tui, state);
  try {
    await runtime.createTab(tab, {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    const target = await runtime.forkSession("source", "target");
    await handleSubmittedInput(state, runtime, `/import ${target.getSessionFile()!}`, tui);
    assert.deepEqual(beforeSwitch, { active: "source", shared: ["source"], source: "source" });
    assert.equal(state.activeTabId, "source");
    assert.deepEqual(readOpenTabs(file), ["source"]);
    assert.equal(tab.toast?.message, "Import cancelled.");
  } finally {
    unbind();
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed withSession callback keeps the already committed new conversation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-replacement-callback-failure-"));
  const file = path.join(root, "open_tabs.json");
  configureOpenTabsPath(file);
  writeOpenTabs(file, ["source"]);
  const state = createInitialState(root);
  const tab = createTab(1, "source", root);
  state.tabs = [tab];
  state.activeTabId = "source";
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
  });
  const unbind = bindRuntimeRendering(runtime, { requestRender() {} }, state);
  try {
    await runtime.createTab(tab, {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    await runtime.prompt("source", "old task");
    await assert.rejects(
      runtime.extensionNewSession("source", {
        withSession: async (ctx) => {
          await ctx.sendUserMessage("new task");
          throw new Error("handoff failed");
        },
      }),
      /handoff failed/,
    );
    const newId = tab.sessionId;
    assert.notEqual(newId, "source");
    assert.equal(state.activeTabId, newId);
    assert.deepEqual(readOpenTabs(file), [newId]);
    await runtime.prompt(newId, "continue");
    const users = runtime
      .getTab(newId)!
      .chat.filter((line) => line.role === "user")
      .map((line) => line.text);
    assert.deepEqual(users, ["new task", "continue"]);
  } finally {
    unbind();
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
