import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderHome,
  renderInputMeta,
  tabBarHitRegions,
} from "./helpers/mixcode.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";
import { closeAppOverlay } from "../src/ui/app-overlays.js";

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
      await Bun.sleep(10);
    }
  }
  throw lastError;
}

test("global key input toggles MixCode overlays and passes through regular input", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    unreadDone: true,
    previewMessages: [
      { role: "user", text: "one" },
      {
        role: "assistant",
        text: Array.from({ length: 8 }, (_, index) => `line-${index}`).join("\n"),
      },
    ],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  let overlayOpen = false;
  let renders = 0;
  const renderForces: Array<boolean | undefined> = [];
  let stopped = false;
  const closedAll: string[] = [];
  const executedCommands: string[] = [];
  const extensionEnabledChanges: Array<{ key: string; enabled: boolean }> = [];
  let reloadedExtensionTab = "";
  const tui = {
    requestRender: (force?: boolean) => {
      renders++;
      renderForces.push(force);
    },
    showOverlay: (component: { render: (width: number) => string[] }) => {
      overlayOpen = true;
      overlays.push(component.render(120).join("\n"));
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
    stop: () => {
      stopped = true;
      overlayOpen = false;
    },
  };
  const quitRuntime = {
    closeAllTabs: async () => {
      closedAll.push("closeAll");
    },
  } as unknown as MixCodeRuntime;
  const extensionRuntime = {
    getExtensionManagerEntries: () => [
      {
        key: "project:inline:top-level:<inline>",
        enabled: true,
        path: "<inline>",
        resolvedPath: "<inline>",
        source: "inline",
        scope: "project",
        origin: "top-level",
        toolCount: 1,
        commandCount: 1,
        toolNames: ["inline_tool"],
        commandNames: ["inline"],
      },
    ],
    setExtensionEnabled: async (_sessionId: string, key: string, enabled: boolean) => {
      extensionEnabledChanges.push({ key, enabled });
    },
    reloadExtensionManagerTab: async (sessionId: string) => {
      reloadedExtensionTab = sessionId;
      return { sessionId, title: "Agent-01", status: "reloaded" as const };
    },
    reloadExtensionManagerWorkdir: async () => [],
  } as unknown as MixCodeRuntime;

  assert.equal(handleMixCodeKeyInput(state, "x", tui), undefined);
  assert.equal(handleMixCodeKeyInput(state, "\x16", tui), undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x0f", tui), { consume: true });
  assert.equal(tab.extensionUi.toolsExpanded, true);
  assert.equal(renders, 1);
  renderInputMeta(tab, 120, 31);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;2;30M", tui), undefined);
  assert.equal(state.picker, undefined);
  const workdirRegion = tab.inputMetaHitRegions?.find((region) => region.action === "workdir");
  assert.ok(workdirRegion);
  assert.deepEqual(handleMixCodeKeyInput(state, `\x1b[<0;${workdirRegion.startX};31M`, tui), {
    consume: true,
  });
  assert.equal(state.picker?.kind, "workdir");
  assert.match(overlays.at(-1) ?? "", /Change Workdir/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  renderInputMeta(tab, 120, 31);
  const modelRegion = tab.inputMetaHitRegions?.find((region) => region.action === "models");
  assert.ok(modelRegion);
  assert.deepEqual(handleMixCodeKeyInput(state, `\x1b[<0;${modelRegion.startX};31M`, tui), {
    consume: true,
  });
  assert.equal(state.picker?.kind, "models");
  assert.match(overlays.at(-1) ?? "", /Choose Model/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  renderInputMeta(tab, 120, 31);
  const thinkingRegion = tab.inputMetaHitRegions?.find((region) => region.action === "thinking");
  assert.ok(thinkingRegion);
  assert.equal(
    handleMixCodeKeyInput(state, `\x1b[<0;${thinkingRegion.startX - 1};31M`, tui),
    undefined,
  );
  assert.deepEqual(handleMixCodeKeyInput(state, `\x1b[<0;${thinkingRegion.startX};31M`, tui), {
    consume: true,
  });
  assert.equal(state.picker?.kind, "thinking");
  assert.match(overlays.at(-1) ?? "", /Choose Thinking/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  // Stale agent meta hit regions must not fire while MixCode Home is active.
  renderInputMeta(tab, 120, 31);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const homeWorkdirRegion = tab.inputMetaHitRegions?.find((region) => region.action === "workdir");
  assert.ok(homeWorkdirRegion);
  assert.equal(
    handleMixCodeKeyInput(state, `\x1b[<0;${homeWorkdirRegion.startX};31M`, tui),
    undefined,
  );
  assert.equal(state.picker, undefined);
  state.activeTabId = "s1";
  const mouseBeta = createTab(2, "s2", "/repo", { title: "Beta", unreadDone: true });
  state.tabs.push(mouseBeta);
  const betaTabRegion = tabBarHitRegions(state).find((region) => region.id === "s2");
  assert.ok(betaTabRegion);
  assert.deepEqual(handleMixCodeKeyInput(state, `\x1b[<0;${betaTabRegion.startX};1M`, tui), {
    consume: true,
  });
  assert.equal(state.activeTabId, "s2");
  assert.equal(mouseBeta.unreadDone, false);
  state.activeTabId = "s1";
  let extensionMouseConsumed = false;
  const mouseConsumingRuntime = {
    dispatchTerminalInput: (_sessionId: string, data: string) => {
      if (data.startsWith("\x1b[<")) {
        extensionMouseConsumed = true;
        return { consume: true };
      }
      return undefined;
    },
  } as unknown as MixCodeRuntime;
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      `\x1b[<0;${betaTabRegion.startX};1M`,
      tui,
      undefined,
      mouseConsumingRuntime,
    ),
    { consume: true },
  );
  assert.equal(state.activeTabId, "s2");
  assert.equal(extensionMouseConsumed, false);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b[<0;80;20M", tui, undefined, mouseConsumingRuntime),
    { consume: true },
  );
  assert.equal(extensionMouseConsumed, true);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;0;1M", tui), undefined);
  assert.equal(state.activeTabId, "s2");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<0;1;1M", tui), { consume: true });
  assert.equal(state.activeTabId, "home");
  state.activeTabId = "s1";
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;80;1M", tui), undefined);
  assert.equal(state.activeTabId, "s1");
  tab.extensionUi.header = { lines: ["extension header"] };
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<0;30;2M", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  state.activeTabId = "s1";
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;30;1M", tui), undefined);
  assert.equal(state.activeTabId, "s1");
  tab.extensionUi.header = undefined;
  tab.chatScrollOffset = 0;
  assert.equal(handleMixCodeKeyInput(state, "\x16", tui), undefined);
  assert.equal(handleMixCodeKeyInput(state, "z", tui), undefined);
  tab.chatScrollOffset = 0;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<65;20;6M", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<64;20;6M", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 3);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<65;20;6M", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[5~", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 10);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[6~", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[H", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 1_000_000);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[F", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  overlayOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x1b[5~", tui), undefined);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<64;20;6M", tui), undefined);
  assert.equal(tab.chatScrollOffset, 0);
  overlayOpen = false;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /Tab Jump/);
  assert.equal(state.tabJumpOpen, true);
  assert.match(overlays.at(-1) ?? "", /Agent-01/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.tabJumpOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /Command Palette/);
  assert.match(overlays.at(-1) ?? "", /Choose Model/);
  assert.doesNotMatch(overlays.at(-1) ?? "", /\/review/);
  assert.equal(state.commandPaletteOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "t", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "h", tui), { consume: true });
  assert.match(stripAnsi(overlays.at(-1) ?? ""), /Choose Thinking Tier[\s\S]*\/thinking/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  for (const ch of "settings") {
    assert.deepEqual(handleMixCodeKeyInput(state, ch, tui), { consume: true });
  }
  assert.match(stripAnsi(overlays.at(-1) ?? ""), /Settings[\s\S]*\/settings/);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: (command: string) => {
        executedCommands.push(command);
      },
    }),
    { consume: true },
  );
  assert.deepEqual(executedCommands, ["/settings"]);
  assert.equal(state.commandPaletteOpen, false);
  assert.equal(overlayOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: () => Promise.reject("string failure"),
    }),
    { consume: true },
  );
  assert.equal(state.commandPaletteOpen, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlays.at(-1) ?? "", /string failure/);
  closeAppOverlay(tui);
  overlayOpen = false;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.throws(
    () => handleMixCodeKeyInput(state, "\r", tui),
    /Command palette selection requires command execution support/,
  );
  assert.equal(state.commandPaletteOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, false);
  closeAppOverlay(tui);
  overlayOpen = false;
  const extensionCommand = { name: "inspect-context", description: "Inspect extension context" };
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x10",
      tui,
      undefined,
      {
        getExtensionCommands: () => [extensionCommand],
      } as never,
      undefined,
      undefined,
      undefined,
      {
        executeCommand: (command: string) => {
          executedCommands.push(command);
        },
        extensionCommands: () => [extensionCommand],
      },
    ),
    { consume: true },
  );
  for (const key of "inspect") {
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        key,
        tui,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          executeCommand: () => undefined,
          extensionCommands: () => [extensionCommand],
        },
      ),
      { consume: true },
    );
  }
  assert.match(stripAnsi(overlays.at(-1) ?? ""), /inspect-context/);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: (command: string) => {
        executedCommands.push(command);
      },
      extensionCommands: () => [extensionCommand],
    }),
    { consume: true },
  );
  assert.equal(executedCommands.at(-1), "/inspect-context");
  overlayOpen = false;
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x10",
      tui,
      undefined,
      {
        getExtensionCommands: () => [extensionCommand],
      } as never,
      undefined,
      undefined,
      undefined,
      {
        executeCommand: (command: string) => {
          executedCommands.push(command);
        },
        extensionCommands: () => [extensionCommand],
      },
    ),
    { consume: true },
  );
  for (const key of "inspect") {
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        key,
        tui,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          executeCommand: () => undefined,
          extensionCommands: () => [extensionCommand],
        },
      ),
      { consume: true },
    );
  }
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[B",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        executeCommand: () => undefined,
        extensionCommands: () => [extensionCommand],
      },
    ),
    { consume: true },
  );
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: (command: string) => {
        executedCommands.push(command);
      },
      extensionCommands: () => [extensionCommand],
    }),
    { consume: true },
  );
  assert.equal(executedCommands.at(-1), "/inspect-context");
  overlayOpen = false;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui), { consume: true });
  // Modal palette swallows unbound control bytes so they cannot fall through.
  assert.deepEqual(handleMixCodeKeyInput(state, "\u0000", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, false);
  await handleSubmittedInput(state, extensionRuntime, "/extension-manager", tui);
  assert.equal(state.extensionManager.open, true);
  assert.match(overlays.at(-1) ?? "", /Extension Manager/);
  assert.match(overlays.at(-1) ?? "", /<inline>/);
  assert.deepEqual(handleMixCodeKeyInput(state, " ", tui, undefined, extensionRuntime), {
    consume: true,
  });
  assert.equal(state.extensionManager.entries[0]?.enabled, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, extensionRuntime), {
    consume: true,
  });
  await waitFor(async () => {
    assert.deepEqual(extensionEnabledChanges, [
      { key: "project:inline:top-level:<inline>", enabled: false },
    ]);
    assert.equal(reloadedExtensionTab, "s1");
  });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, extensionRuntime), {
    consume: true,
  });
  assert.equal(state.extensionManager.open, false);
  state.activeTabId = "home";
  renderHome(state, 100);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;10;10M", tui), undefined);
  assert.equal(state.picker, undefined);
  assert.equal(state.commandPaletteOpen, false);
  state.activeTabId = "s1";
  assert.equal(state.activeTabId, "s1");
  overlayOpen = true;
  state.tabJumpOpen = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.tabJumpOpen, false);
  assert.equal(state.commandPaletteOpen, false);
  assert.equal(state.picker, undefined);
  overlayOpen = false;
  state.activeTabId = "home";
  assert.equal(handleMixCodeKeyInput(state, "q", tui), undefined);
  assert.equal(state.quitConfirmOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x11", tui), { consume: true });
  assert.equal(state.quitConfirmOpen, true);
  assertQuitOverlay(overlays.at(-1));
  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui), { consume: true });
  assert.equal(state.quitConfirmOpen, false);
  assert.equal(overlayOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x11", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.quitConfirmOpen, false);
  assert.equal(overlayOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x11", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, quitRuntime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.quitConfirmOpen, false);
  assert.equal(stopped, true);
  assert.equal(overlayOpen, false);
  assert.deepEqual(closedAll, ["closeAll"]);
  assert.equal(handleMixCodeKeyInput(state, "r", tui), undefined);
  assert.notEqual(tab.status, "running");
  state.activeTabId = "s1";
  overlayOpen = false;
  assert.equal(handleMixCodeKeyInput(state, "q", tui), undefined);
  assert.equal(handleMixCodeKeyInput(state, "r", tui), undefined);
});
