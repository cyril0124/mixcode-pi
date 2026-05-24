import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createDialogRequest,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  renderQuestionOverlay,
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
  const editorText = "";
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
      return {} as never;
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
  assert.equal(tab.previewOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x0f", tui), { consume: true });
  assert.equal(tab.extensionUi.toolsExpanded, true);
  tab.previewOpen = true;
  assert.equal(tab.previewOpen, true);
  assert.equal(renders, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "l", tui), { consume: true });
  assert.equal(tab.previewIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(tab.previewHint, "No newer message");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[D", tui), { consume: true });
  assert.equal(tab.previewIndex, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(tab.previewIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 3);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<65;20;6M", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 6);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[<64;20;6M", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 3);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;20;6M", tui), undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 6);
  assert.deepEqual(handleMixCodeKeyInput(state, "k", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 3);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "G", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 7);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[F", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 7);
  assert.deepEqual(handleMixCodeKeyInput(state, "g", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 7);
  assert.deepEqual(handleMixCodeKeyInput(state, "g", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[H", tui), { consume: true });
  assert.equal(tab.previewScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "h", tui), { consume: true });
  assert.equal(tab.previewIndex, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "h", tui), { consume: true });
  assert.equal(tab.previewHint, "No older message");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(tab.previewOpen, false);
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
  const mouseBeta = createTab(2, "s2", "/repo", { title: "Beta", unreadDone: true });
  state.tabs.push(mouseBeta);
  const betaTabRegion = tabBarHitRegions(state).find((region) => region.id === "s2");
  assert.ok(betaTabRegion);
  assert.deepEqual(handleMixCodeKeyInput(state, `\x1b[<0;${betaTabRegion.startX};1M`, tui), {
    consume: true,
  });
  assert.equal(state.activeTabId, "s2");
  assert.equal(mouseBeta.unreadDone, false);
  assert.equal(renderForces.at(-1), undefined);
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
  assert.equal(state.activeTabId, "config");
  assert.equal(renderForces.at(-1), undefined);
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
  assert.equal(tab.previewOpen, false);
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
  assert.match(overlays.at(-1) ?? "", /> Choose Thinking Tier\s+\/thinking/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /> Choose Theme\s+\/theme/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /> Choose Thinking Tier\s+\/thinking/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /> Choose Theme\s+\/theme/);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: (command: string) => {
        executedCommands.push(command);
      },
    }),
    { consume: true },
  );
  assert.equal(editorText, "");
  assert.deepEqual(executedCommands, ["/theme"]);
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
  overlayOpen = false;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.throws(
    () => handleMixCodeKeyInput(state, "\r", tui),
    /Command palette selection requires command execution support/,
  );
  assert.equal(state.commandPaletteOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, false);
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
  assert.match(overlays.at(-1) ?? "", /inspect-context/);
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
  assert.equal(handleMixCodeKeyInput(state, "\u0000", tui), undefined);
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
  assert.deepEqual(handleMixCodeKeyInput(state, "\x0c", tui), { consume: true });
  assert.match(overlays.at(-1) ?? "", /Latest Agent Reply/);
  assert.equal(state.exportChooserOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.exportChooserIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  state.activeTabId = "config";
  renderConfig(state, 100);
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;10;10M", tui), undefined);
  assert.equal(state.picker, undefined);
  assert.equal(state.commandPaletteOpen, false);
  state.activeTabId = "s1";
  assert.equal(state.activeTabId, "s1");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.exportChooserIndex, 0);
  overlayOpen = true;
  state.exportChooserOpen = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.exportChooserOpen, false);
  assert.equal(state.commandPaletteOpen, false);
  assert.equal(state.tabJumpOpen, false);
  assert.equal(state.picker, undefined);
  overlayOpen = false;
  state.activeTabId = "config";
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
  const refreshRuntime = {
    refreshAllTabStatuses: () => {
      tab.status = "running";
      return [tab];
    },
  };
  assert.equal(handleMixCodeKeyInput(state, "r", tui, undefined, refreshRuntime), undefined);
  assert.notEqual(tab.status, "running");
  state.activeTabId = "s1";
  overlayOpen = false;
  assert.equal(handleMixCodeKeyInput(state, "q", tui), undefined);
  assert.equal(handleMixCodeKeyInput(state, "r", tui, undefined, refreshRuntime), undefined);
});
