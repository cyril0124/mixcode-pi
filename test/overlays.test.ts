import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  acceptCommandPaletteSelection,
  acceptTabJumpSelection,
  filterTabJumpEntries,
  closeCommandPalette,
  closeTabJump,
  moveCommandPaletteSelection,
  moveTabJumpSelection,
  openCommandPalette,
  openTabJump,
  renderCommandPalette,
  renderTabJumpOverlay,
  tabJumpEntries,
  toggleTabJumpNonIdleOnly,
  updateCommandPaletteQuery,
  commandPaletteEntriesWithExtensions,
  updateTabJumpQuery,
} from "./helpers/mixcode.js";

test("command palette derives every palette-visible LOCAL_COMMANDS entry", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  openCommandPalette(state);
  const commands = new Set(commandPaletteEntriesWithExtensions(state).map((entry) => entry.command));
  // Newly registered local commands must appear without touching overlays.ts.
  assert.ok(commands.has("/toggle-hidden-messages"), "palette derives /toggle-hidden-messages");
  assert.ok(commands.has("/jump"), "palette derives /jump");
  assert.ok(commands.has("/editor"), "palette derives /editor");
  assert.equal(commands.has("/palette"), false, "command palette omits /palette");
  // Config-scoped view must also derive from the same source.
  const configState = createInitialState("/repo");
  openCommandPalette(configState);
  const configCommands = new Set(
    commandPaletteEntriesWithExtensions(configState).map((entry) => entry.command),
  );
  assert.ok(configCommands.has("/save-workspace"), "config palette keeps workspace commands");
  assert.ok(configCommands.has("/jump"), "config palette keeps /jump");
  assert.ok(configCommands.has("/editor"), "config palette keeps /editor");
  assert.equal(configCommands.has("/palette"), false, "config palette omits /palette");
});

test("tab jump entries expose busy, done, question, and fuzzy filtering", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "alpha", status: "running", unreadDone: true }),
    createTab(2, "s2", "/repo", {
      title: "Beta",
      extensionUi: {
        statuses: [],
        widgets: [],
        toolsExpanded: false,
        waitingForInputs: [{ id: "q", kind: "custom" }],
        workingVisible: true,
      },
    }),
  );
  const entries = tabJumpEntries(state);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["home", "s1", "s2"],
  );
  assert.equal(entries[1]?.busy, true);
  assert.equal(entries[1]?.done, true);
  assert.equal(entries[2]?.waitingForInput, true);
  assert.deepEqual(
    filterTabJumpEntries(state, "bt").map((entry) => entry.id),
    ["s2"],
  );
  assert.equal(filterTabJumpEntries(state, "").length, 3);
});

test("tab jump state opens, filters, moves, accepts, and closes", () => {
  const state = createInitialState("/repo");
  const alpha = createTab(1, "s1", "/repo", { title: "alpha", unreadDone: true });
  state.tabs.push(alpha, createTab(2, "s2", "/repo", { title: "Beta" }));
  const longId = "019eb998-93ad-73cb-9a84-2f129ae26b41";
  state.tabs.push(createTab(3, longId, "/repo", { title: "Gamma session" }));
  state.activeTabId = "s2";
  openTabJump(state);
  assert.equal(state.tabJumpOpen, true);
  assert.equal(state.tabJumpIndex, 2);
  const initialOverlay = stripAnsi(renderTabJumpOverlay(state, 80).join("\n"));
  assert.match(initialOverlay, /Search\s+4\/4 tabs/);
  assert.match(initialOverlay, /›\s+Beta\s+s2/);
  assert.match(initialOverlay, /Gamma session\s+019eb998-93ad-73cb-9a84-2f129ae26b41/);
  const narrowOverlay = stripAnsi(renderTabJumpOverlay(state, 48).join("\n"));
  assert.match(narrowOverlay, /Gamma session\s+019eb998/);
  assert.doesNotMatch(narrowOverlay, /019eb998-93ad/);

  updateTabJumpQuery(state, "al");
  assert.deepEqual(
    filterTabJumpEntries(state, state.tabJumpQuery).map((entry) => entry.id),
    ["s1"],
  );
  assert.equal(state.tabJumpIndex, 0);
  assert.match(stripAnsi(renderTabJumpOverlay(state, 80).join("\n")), /alpha/);
  assert.equal(acceptTabJumpSelection(state), "s1");
  assert.equal(state.activeTabId, "s1");
  assert.equal(alpha.unreadDone, false);
  assert.equal(state.tabJumpOpen, false);

  openTabJump(state);
  moveTabJumpSelection(state, -1);
  assert.equal(state.tabJumpIndex, 0);
  moveTabJumpSelection(state, 99);
  assert.equal(state.tabJumpIndex, 3);
  updateTabJumpQuery(state, "missing");
  assert.match(renderTabJumpOverlay(state, 80).join("\n"), /No matching tabs/);
  assert.equal(acceptTabJumpSelection(state), "");
  assert.equal(state.activeTabId, "s1");
  openTabJump(state);
  updateTabJumpQuery(state, "");
  state.tabs[0]!.unreadDone = true;
  state.tabs[0]!.status = "idle";
  state.tabs[1]!.extensionUi.waitingForInputs = [];
  state.tabs[1]!.unreadDone = true;
  state.tabs[1]!.status = "done";
  const statusOverlay = stripAnsi(renderTabJumpOverlay(state, 80).join("\n"));
  assert.match(statusOverlay, /!\s+Beta\s+s2/);
  assert.match(
    statusOverlay,
    /type filter · ↑↓\/tab select · ctrl\+f non-idle · enter jump · esc cancel/,
  );
  closeTabJump(state);
  assert.equal(state.tabJumpQuery, "");
});

test("tab jump ctrl+f toggles non-idle filter and resets on reopen", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "alpha", status: "running" }),
    createTab(2, "s2", "/repo", { title: "Beta", status: "idle" }),
    createTab(3, "s3", "/repo", { title: "Gamma", status: "idle", unreadDone: true }),
    createTab(4, "s4", "/repo", { title: "Delta", status: "error" }),
  );
  state.activeTabId = "s2";
  openTabJump(state);
  assert.deepEqual(
    filterTabJumpEntries(state, "").map((entry) => entry.id),
    ["home", "s1", "s2", "s3", "s4"],
  );

  toggleTabJumpNonIdleOnly(state);
  assert.equal(state.tabJumpNonIdleOnly, true);
  assert.deepEqual(
    filterTabJumpEntries(state, "").map((entry) => entry.id),
    ["s1", "s3", "s4"],
  );
  // Active idle tab drops out; index clamps into the filtered list.
  assert.ok(state.tabJumpIndex < filterTabJumpEntries(state, "").length);
  assert.match(stripAnsi(renderTabJumpOverlay(state, 80).join("\n")), /non-idle/);

  // Query stacks on top of non-idle filter.
  updateTabJumpQuery(state, "ga");
  assert.deepEqual(
    filterTabJumpEntries(state, state.tabJumpQuery).map((entry) => entry.id),
    ["s3"],
  );

  closeTabJump(state);
  assert.equal(state.tabJumpNonIdleOnly, false);
  openTabJump(state);
  assert.equal(state.tabJumpNonIdleOnly, false);
  assert.deepEqual(
    filterTabJumpEntries(state, "").map((entry) => entry.id),
    ["home", "s1", "s2", "s3", "s4"],
  );
});

test("command palette filters, accepts, disables, and closes without OpenCode entries", () => {
  const state = createInitialState("/repo");
  openCommandPalette(state);
  assert.equal(state.commandPaletteOpen, true);
  assert.ok(
    commandPaletteEntriesWithExtensions(state).some(
      (entry) => entry.label === "Settings" && entry.command === "/settings",
    ),
  );
  assert.equal(
    commandPaletteEntriesWithExtensions(state).some((entry) => entry.command === "/review"),
    false,
  );
  assertNoOpenCodePaletteEntries(commandPaletteEntriesWithExtensions(state));
  updateCommandPaletteQuery(state, "settings");
  assert.deepEqual(
    commandPaletteEntriesWithExtensions(state).map((entry) => entry.command),
    ["/settings"],
  );
  assert.equal(acceptCommandPaletteSelection(state), "/settings");
  assert.equal(state.commandPaletteOpen, false);

  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  openCommandPalette(state);
  const sessionCommands = new Set(commandPaletteEntriesWithExtensions(state).map((entry) => entry.command));
  for (const command of [
    "/models",
    "/thinking",
    "/settings",
    "/system-prompt",
    "/toggle-hidden-messages",
    "/vim",
    "/login",
    "/logout",
    "/quit",
  ]) {
    assert.ok(sessionCommands.has(command), `session palette includes ${command}`);
  }
  assert.equal(sessionCommands.has("/review"), false);
  assertNoOpenCodePaletteEntries(commandPaletteEntriesWithExtensions(state));

  updateCommandPaletteQuery(state, "system prompt");
  assert.deepEqual(
    commandPaletteEntriesWithExtensions(state).map((entry) => entry.command),
    ["/system-prompt"],
  );
  assert.equal(acceptCommandPaletteSelection(state), "/system-prompt");
  openCommandPalette(state);
  updateCommandPaletteQuery(state, "vim mode");
  assert.deepEqual(
    commandPaletteEntriesWithExtensions(state).map((entry) => entry.command),
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
  // Extension-only /theme is allowed once the built-in /theme command is gone.
  assert.equal(entriesWithExtensions.filter((entry) => entry.command === "/theme").length, 1);
  assert.equal(entriesWithExtensions.filter((entry) => entry.command === "/settings").length, 1);
  assert.equal(
    entriesWithExtensions.find((entry) => entry.command === "/explain-selection")?.description,
    "Extension command",
  );
  updateCommandPaletteQuery(state, "inspect");
  assert.deepEqual(
    commandPaletteEntriesWithExtensions(state).map((entry) => entry.command),
    [],
  );
  assert.match(stripAnsi(renderCommandPalette(state, 100, extensionCommands).join("\n")), /inspect-context/);
  assert.equal(acceptCommandPaletteSelection(state, extensionCommands), "/inspect-context");

  state.availableModels = [];
  openCommandPalette(state);
  const modelEntry = commandPaletteEntriesWithExtensions(state).find((entry) => entry.command === "/models");
  assert.equal(modelEntry?.enabled, false);
  // Disabled rows are omitted from selection; Enter runs the first visible command.
  const firstVisible = commandPaletteEntriesWithExtensions(state).find((entry) => entry.enabled);
  assert.ok(firstVisible);
  assert.notEqual(firstVisible.command, "/models");
  assert.equal(acceptCommandPaletteSelection(state), firstVisible.command);
  state.availableModels = [{ ...state.model }];

  state.tabs[0]!.sessionId = "";
  state.activeTabId = "";
  openCommandPalette(state);
  const sessionEntries = commandPaletteEntriesWithExtensions(state);
  assert.equal(sessionEntries.find((entry) => entry.command === "/thinking")?.enabled, false);
  assert.equal(
    sessionEntries.find((entry) => entry.command === "/delete-all-sessions")?.enabled,
    true,
  );
  state.activeTabId = "missing";
  assert.deepEqual(commandPaletteEntriesWithExtensions(state), []);
  state.tabs[0]!.sessionId = "s1";
  state.activeTabId = "s1";

  openCommandPalette(state);
  moveCommandPaletteSelection(state, -1);
  assert.ok(state.commandPalette.selectedIndex > 0);
  updateCommandPaletteQuery(state, "missing");
  assert.deepEqual(commandPaletteEntriesWithExtensions(state), []);
  assert.match(renderCommandPalette(state, 80).join("\n"), /No matching commands/);
  // Query change always resets selection to the new top hit (0).
  assert.equal(state.commandPalette.selectedIndex, 0);
  assert.equal(acceptCommandPaletteSelection(state), "");
  assert.equal(state.commandPaletteOpen, false);

  openCommandPalette(state);
  moveCommandPaletteSelection(state, 1);
  const secondIndex = state.commandPalette.selectedIndex;
  assert.ok(secondIndex > 0);
  updateCommandPaletteQuery(state, "new");
  assert.equal(state.commandPalette.selectedIndex, 0);
  const filtered = commandPaletteEntriesWithExtensions(state);
  assert.ok(filtered.some((entry) => entry.command === "/new-session"));
  assert.equal(acceptCommandPaletteSelection(state), "/new-session");

  openCommandPalette(state);
  closeCommandPalette(state);
  assert.equal(state.commandPalette.query, "");
});

test("command palette selection skips disabled entries (matches visible rows)", () => {
  // Home with no tabs: Close All / Save Workspace are disabled and hidden in the
  // renderer. Down once must select the second *visible* command, not all[1].
  const state = createInitialState("/repo");
  state.activeTabId = "home";
  assert.equal(state.tabs.length, 0);

  const all = commandPaletteEntriesWithExtensions(state);
  const visible = all.filter((entry) => entry.enabled);
  assert.ok(all.some((entry) => !entry.enabled), "fixture needs disabled rows");
  assert.ok(visible.length >= 2);
  assert.notEqual(all[1]?.command, visible[1]?.command);

  openCommandPalette(state);
  moveCommandPaletteSelection(state, 1);
  assert.equal(state.commandPalette.selectedIndex, 1);
  assert.equal(acceptCommandPaletteSelection(state), visible[1]!.command);
});

test("command palette filter matches per-token subsequence, not scattered fuzzy", () => {
  // Regression: pi's scattered-subsequence fuzzy kept rows whose label/command
  // never actually contained the query as an in-order token (e.g. "done"
  // matching "Toggle Hidden Messages" via t..o..d..? scattered across words),
  // so the filtered list showed rows with zero highlighted characters. The
  // filter now uses the same fuzzyMatchAllPositions matcher as the renderer.
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  openCommandPalette(state);
  updateCommandPaletteQuery(state, "done");
  assert.deepEqual(
    commandPaletteEntriesWithExtensions(state).map((entry) => entry.command),
    ["/mark-done"],
  );
});

function assertNoOpenCodePaletteEntries(entries: ReturnType<typeof commandPaletteEntriesWithExtensions>): void {
  const text = entries
    .map((entry) => `${entry.label} ${entry.command} ${entry.description}`)
    .join("\n");
  assert.doesNotMatch(text, /opencode|Attach Session|Connect|Reconnect|code-tui/i);
}
