import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  acceptCommandPaletteSelection,
  acceptTabJumpSelection,
  commandPaletteEntries,
  filterTabJumpEntries,
  closeCommandPalette,
  closeTabJump,
  moveCommandPaletteSelection,
  moveTabJumpSelection,
  navigatePreview,
  openCommandPalette,
  openTabJump,
  previewEnd,
  previewHome,
  previewTitle,
  renderCommandPalette,
  renderPreviewOverlay,
  renderShellOverlay,
  renderTabJumpOverlay,
  chatEnd,
  chatHome,
  scrollChat,
  scrollPreview,
  scrollShell,
  tabJumpEntries,
  togglePreview,
  toggleShell,
  updateCommandPaletteQuery,
  commandPaletteEntriesWithExtensions,
  updateTabJumpQuery,
} from "../src/index.js";

test("shell and preview overlays toggle and render", () => {
  const tab = createTab(1, "s1", "/repo");
  assert.deepEqual(renderShellOverlay(tab, 80), []);
  assert.deepEqual(renderPreviewOverlay(tab, 80), []);
  toggleShell(tab);
  togglePreview(tab);
  assert.equal(tab.shellOpen, true);
  assert.equal(tab.previewOpen, true);
  assert.equal(navigatePreview(tab, 1), false);
  assert.equal(scrollPreview(tab, 1), true);
  togglePreview(tab);
  assert.equal(scrollPreview(tab, 1), false);
  assert.equal(previewHome(tab), false);
  assert.equal(previewEnd(tab), false);
  togglePreview(tab);
  assert.match(renderShellOverlay(tab, 80).join("\n"), /Shell/);
  tab.shellSession = { cwd: "/repo", command: "sh", pid: 123, buffer: ["hello"], input: "ec" };
  assert.match(renderShellOverlay(tab, 80).join("\n"), /hello/);
  assert.match(renderShellOverlay(tab, 80).join("\n"), /\$ ec/);
  tab.shellSession.buffer = Array.from({ length: 20 }, (_, index) => `shell-${index}`);
  assert.equal(scrollShell(tab, 3), true);
  assert.equal(tab.shellScrollOffset, 3);
  assert.match(renderShellOverlay(tab, 80).join("\n"), /scroll: 4\/5/);
  assert.doesNotMatch(renderShellOverlay(tab, 80).join("\n"), /shell-0/);
  assert.match(renderShellOverlay(tab, 80).join("\n"), /shell-3/);
  assert.equal(scrollShell(tab, Number.POSITIVE_INFINITY), true);
  assert.equal(tab.shellScrollOffset, 4);
  assert.equal(scrollShell(tab, Number.NEGATIVE_INFINITY), true);
  assert.equal(tab.shellScrollOffset, 0);
  tab.shellSession.exitCode = 0;
  assert.match(renderShellOverlay(tab, 80).join("\n"), /exited: 0/);
  assert.match(renderPreviewOverlay(tab, 80).join("\n"), /No preview messages yet/);
  tab.previewMessages.push(
    { role: "user", text: "Prompt" },
    { role: "assistant", text: "# Answer\n\nDetails\nMore" },
  );
  assert.equal(previewTitle(tab), "User Message 1 / 2");
  assert.match(renderPreviewOverlay(tab, 80).join("\n"), /Prompt/);
  assert.equal(navigatePreview(tab, 1), true);
  assert.equal(previewTitle(tab), "Assistant Message 2 / 2");
  tab.previewMessages[1] = { role: "shell", text: "cmd\nout" };
  assert.equal(previewTitle(tab), "Shell Message 2 / 2");
  tab.previewMessages[1] = { role: "tool", text: "tool output" };
  assert.equal(previewTitle(tab), "Tool Message 2 / 2");
  tab.previewMessages[1] = { role: "thinking", text: "thought" };
  assert.equal(previewTitle(tab), "Thinking Message 2 / 2");
  tab.previewMessages[1] = { role: "system", text: "notice" };
  assert.equal(previewTitle(tab), "System Message 2 / 2");
  tab.previewMessages[1] = { role: "empty", text: "empty" };
  assert.equal(previewTitle(tab), "Message Message 2 / 2");
  tab.previewMessages[1] = { role: "assistant", text: "# Answer\n\nDetails\nMore" };
  assert.match(renderPreviewOverlay(tab, 80).join("\n"), /# Answer/);
  assert.equal(scrollPreview(tab, 2), true);
  assert.match(renderPreviewOverlay(tab, 80).join("\n"), /scroll: 3\/4/);
  assert.equal(previewHome(tab), true);
  assert.match(renderPreviewOverlay(tab, 80).join("\n"), /scroll: 1\/4/);
  assert.equal(previewEnd(tab), true);
  assert.match(renderPreviewOverlay(tab, 80).join("\n"), /scroll: 4\/4/);
  assert.equal(navigatePreview(tab, 1), true);
  assert.equal(previewTitle(tab), "No newer message");
  assert.equal(navigatePreview(tab, -1), true);
  assert.equal(previewTitle(tab), "User Message 1 / 2");
  assert.equal(navigatePreview(tab, -1), true);
  assert.equal(previewTitle(tab), "No older message");
  assert.equal(scrollPreview(createTab(2, "s2", "/repo"), 2), false);
  assert.equal(previewHome(createTab(3, "s3", "/repo")), false);
  assert.equal(previewEnd(createTab(4, "s4", "/repo")), false);
  assert.equal(scrollShell(createTab(5, "s5", "/repo"), 1), false);
  assert.equal(scrollChat(tab, 5), true);
  assert.equal(tab.chatScrollOffset, 5);
  assert.equal(scrollChat(tab, -99), true);
  assert.equal(tab.chatScrollOffset, 0);
  assert.equal(chatHome(tab), true);
  assert.equal(tab.chatScrollOffset, 1_000_000);
  assert.equal(chatEnd(tab), true);
  assert.equal(tab.chatScrollOffset, 0);
});

test("tab jump entries expose busy, done, question, and fuzzy filtering", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { alias: "alpha", status: "running", unreadDone: true }),
    createTab(2, "s2", "/repo", {
      title: "Beta",
      pendingDialogs: [
        {
          requestId: "q",
          sessionId: "s2",
          questions: [],
          currentQuestionIndex: 0,
          highlightedOptionIndices: [],
          selectedAnswers: [],
          customAnswers: [],
          dirty: false,
        },
      ],
    }),
  );
  const entries = tabJumpEntries(state);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["config", "s1", "s2"],
  );
  assert.equal(entries[1]?.busy, true);
  assert.equal(entries[1]?.done, true);
  assert.equal(entries[2]?.question, true);
  assert.deepEqual(
    filterTabJumpEntries(state, "bt").map((entry) => entry.id),
    ["s2"],
  );
  assert.equal(filterTabJumpEntries(state, "").length, 3);
});

test("tab jump state opens, filters, moves, accepts, and closes", () => {
  const state = createInitialState("/repo");
  const alpha = createTab(1, "s1", "/repo", { alias: "alpha", unreadDone: true });
  state.tabs.push(alpha, createTab(2, "s2", "/repo", { title: "Beta" }));
  state.activeTabId = "s2";
  openTabJump(state);
  assert.equal(state.tabJumpOpen, true);
  assert.equal(state.tabJumpIndex, 2);
  assert.match(renderTabJumpOverlay(state, 80).join("\n"), /> {3}Beta/);

  updateTabJumpQuery(state, "al");
  assert.deepEqual(
    filterTabJumpEntries(state, state.tabJumpQuery).map((entry) => entry.id),
    ["s1"],
  );
  assert.equal(state.tabJumpIndex, 0);
  assert.match(renderTabJumpOverlay(state, 80).join("\n"), /alpha/);
  assert.equal(acceptTabJumpSelection(state), "s1");
  assert.equal(state.activeTabId, "s1");
  assert.equal(alpha.unreadDone, false);
  assert.equal(state.tabJumpOpen, false);

  openTabJump(state);
  moveTabJumpSelection(state, -1);
  assert.equal(state.tabJumpIndex, 0);
  moveTabJumpSelection(state, 99);
  assert.equal(state.tabJumpIndex, 2);
  updateTabJumpQuery(state, "missing");
  assert.match(renderTabJumpOverlay(state, 80).join("\n"), /No matching tabs/);
  assert.equal(acceptTabJumpSelection(state), "");
  assert.equal(state.activeTabId, "s1");
  openTabJump(state);
  updateTabJumpQuery(state, "");
  state.tabs[0]!.unreadDone = true;
  state.tabs[0]!.status = "idle";
  state.tabs[1]!.pendingDialogs = [];
  state.tabs[1]!.unreadDone = true;
  state.tabs[1]!.status = "done";
  assert.match(renderTabJumpOverlay(state, 80).join("\n"), /! Beta/);
  closeTabJump(state);
  assert.equal(state.tabJumpQuery, "");
});

test("command palette state filters, moves, accepts, and closes", () => {
  const state = createInitialState("/repo");
  openCommandPalette(state);
  assert.equal(state.commandPaletteOpen, true);
  assert.ok(
    commandPaletteEntries(state).some(
      (entry) => entry.label === "Choose Theme" && entry.command === "/theme",
    ),
  );
  assert.equal(
    commandPaletteEntries(state).some((entry) => entry.command === "/review"),
    false,
  );
  assertNoOpenCodePaletteEntries(commandPaletteEntries(state));
  updateCommandPaletteQuery(state, "theme");
  assert.deepEqual(
    commandPaletteEntries(state).map((entry) => entry.command),
    ["/theme"],
  );
  assert.equal(acceptCommandPaletteSelection(state), "/theme");
  assert.equal(state.commandPaletteOpen, false);

  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  openCommandPalette(state);
  assert.deepEqual(
    commandPaletteEntries(state).map((entry) => entry.command),
    [
      "/models",
      "/thinking",
      "/theme",
      "/tui-state",
      "/system-tools",
      "/system-prompt",
      "/extension-manager",
      "/rename",
      "/workdir",
      "/import",
      "/mark-done",
      "/vim",
      "/new-session",
      "/resume",
      "/tree",
      "/close-session",
      "/delete-session",
      "/delete-all-sessions",
    ],
  );
  assertNoOpenCodePaletteEntries(commandPaletteEntries(state));
  updateCommandPaletteQuery(state, "system prompt");
  assert.deepEqual(
    commandPaletteEntries(state).map((entry) => entry.command),
    ["/system-prompt"],
  );
  assert.equal(acceptCommandPaletteSelection(state), "/system-prompt");
  openCommandPalette(state);
  updateCommandPaletteQuery(state, "vim");
  assert.deepEqual(
    commandPaletteEntries(state).map((entry) => entry.command),
    ["/vim"],
  );
  assert.equal(acceptCommandPaletteSelection(state), "/vim");
  openCommandPalette(state);
  const extensionCommands = [
    { name: "", description: "Empty extension command" },
    { name: "inspect-context", description: "Inspect extension context" },
    { name: "theme", description: "Conflicting extension command" },
    { name: "explain-selection" },
  ];
  const entriesWithExtensions = commandPaletteEntriesWithExtensions(state, extensionCommands);
  assert.equal(
    entriesWithExtensions.some((entry) => entry.command === "/"),
    false,
  );
  assert.equal(entriesWithExtensions.filter((entry) => entry.command === "/theme").length, 1);
  assert.equal(
    entriesWithExtensions.find((entry) => entry.command === "/explain-selection")?.description,
    "Extension command",
  );
  updateCommandPaletteQuery(state, "inspect");
  assert.deepEqual(
    commandPaletteEntries(state).map((entry) => entry.command),
    [],
  );
  assert.match(renderCommandPalette(state, 100, extensionCommands).join("\n"), /inspect-context/);
  assert.equal(acceptCommandPaletteSelection(state, extensionCommands), "/inspect-context");

  state.availableModels = [];
  openCommandPalette(state);
  const modelEntry = commandPaletteEntries(state).find((entry) => entry.command === "/models");
  assert.equal(modelEntry?.enabled, false);
  assert.equal(modelEntry?.disabledReason, "No models loaded");
  assert.equal(acceptCommandPaletteSelection(state), "");
  state.availableModels = [{ ...state.model }];

  state.tabs[0]!.sessionId = "";
  state.activeTabId = "";
  openCommandPalette(state);
  const sessionEntries = commandPaletteEntries(state);
  assert.equal(sessionEntries.find((entry) => entry.command === "/thinking")?.enabled, false);
  assert.equal(
    sessionEntries.find((entry) => entry.command === "/thinking")?.disabledReason,
    "Current tab has no active session",
  );
  assert.equal(
    sessionEntries.find((entry) => entry.command === "/delete-all-sessions")?.enabled,
    true,
  );
  state.activeTabId = "missing";
  assert.deepEqual(commandPaletteEntries(state), []);
  state.tabs[0]!.sessionId = "s1";
  state.activeTabId = "s1";

  openCommandPalette(state);
  moveCommandPaletteSelection(state, -1);
  assert.ok(state.commandPalette.selectedIndex > 0);
  updateCommandPaletteQuery(state, "missing");
  assert.deepEqual(commandPaletteEntries(state), []);
  assert.match(renderCommandPalette(state, 80).join("\n"), /No matching commands/);
  moveCommandPaletteSelection(state, 1);
  assert.equal(state.commandPalette.selectedIndex, 0);
  assert.equal(acceptCommandPaletteSelection(state), "");
  assert.equal(state.commandPaletteOpen, false);

  openCommandPalette(state);
  closeCommandPalette(state);
  assert.equal(state.commandPalette.query, "");
});

function assertNoOpenCodePaletteEntries(entries: ReturnType<typeof commandPaletteEntries>): void {
  const text = entries
    .map((entry) => `${entry.label} ${entry.command} ${entry.description}`)
    .join("\n");
  assert.doesNotMatch(text, /opencode|Attach Session|Connect|Reconnect|code-tui/i);
}
