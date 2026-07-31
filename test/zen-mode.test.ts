import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { parseInput, commandSuggestions } from "../src/core/commands.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { createMixCodeTui } from "../src/ui/app.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { MixCodeTheme } from "../src/ui/themes.js";
import type { OverlayTui } from "../src/ui/app-types.js";
import { buildLabeledTopBorder } from "../src/ui/editor-top-border.js";
import {
  renderTabBarSeparator,
  tabBarHitRegions,
  zenUnreadDoneCount,
} from "../src/ui/rendering/chrome.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

const identity = (s: string) => s;

function border(opts: {
  width: number;
  title: string;
  vimMode?: boolean;
  zenMode?: boolean;
}): string {
  return stripAnsi(
    buildLabeledTopBorder({
      width: opts.width,
      title: opts.title,
      vimMode: opts.vimMode === true,
      zenMode: opts.zenMode === true,
      dash: identity,
      vimLabel: identity,
      zenLabel: identity,
      titleLabel: identity,
    }),
  );
}

test("parseInput accepts /toggle-zen-mode", () => {
  assert.deepEqual(parseInput("/toggle-zen-mode"), {
    kind: "local-command",
    command: "toggle-zen-mode",
    args: "",
  });
  assert.ok(commandSuggestions("/toggle-z").includes("toggle-zen-mode"));
});

test("/toggle-zen-mode flips zenMode on the active tab", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  assert.equal(tab.zenMode, false);

  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(state, runtime, "/toggle-zen-mode", tui);
  assert.equal(tab.zenMode, true);

  await handleSubmittedInput(state, runtime, "/toggle-zen-mode", tui);
  assert.equal(tab.zenMode, false);
});

test("zen mode embeds [ZEN] near the left with the title on the right", () => {
  const line = border({ width: 40, title: "Agent-1", zenMode: true });
  assert.equal([...line].length, 40);
  assert.match(line, /^── \[ZEN\] ─/, "zen badge sits after a short left margin");
  assert.match(line, /─ Agent-1 ──$/);
  assert.doesNotMatch(line, /VIM/);
});

test("vim + zen badges sit side by side on the left", () => {
  const line = border({ width: 48, title: "Agent-1", vimMode: true, zenMode: true });
  assert.equal([...line].length, 48);
  assert.match(line, /^── \[VIM\] \[ZEN\] ─/);
  assert.match(line, /─ Agent-1 ──$/);
});

test("zen badge uses zenLabel colorizer independent of vim", () => {
  const line = buildLabeledTopBorder({
    width: 40,
    title: "Agent-1",
    vimMode: true,
    zenMode: true,
    dash: (s) => s,
    vimLabel: (s) => `<v>${s}</v>`,
    zenLabel: (s) => `<z>${s}</z>`,
    titleLabel: (s) => `<t>${s}</t>`,
  });
  assert.match(line, /<v>\[VIM\]<\/v>/);
  assert.match(line, /<z>\[ZEN\]<\/z>/);
  assert.match(line, /<t>Agent-1<\/t>/);
});

test("app-editor wiring: zen follows vimBorder when vim is on, accent when off", () => {
  // Contract: with vim, [ZEN] shares the vim frame color; pure zen uses accent.
  // Mirrors applyTopBorderLabel in app-editor without spinning up the TUI.
  const theme = {
    vimBorder: (s: string) => `<vim>${s}</vim>`,
    accent: (s: string) => `<acc>${s}</acc>`,
  };
  const withVim = buildLabeledTopBorder({
    width: 48,
    title: "Agent-1",
    vimMode: true,
    zenMode: true,
    dash: (s) => s,
    vimLabel: theme.vimBorder,
    zenLabel: theme.vimBorder,
    titleLabel: theme.vimBorder,
  });
  assert.match(withVim, /<vim>\[VIM\]<\/vim>/);
  assert.match(withVim, /<vim>\[ZEN\]<\/vim>/);
  assert.doesNotMatch(withVim, /<acc>/);

  const zenOnly = buildLabeledTopBorder({
    width: 40,
    title: "Agent-1",
    vimMode: false,
    zenMode: true,
    dash: (s) => s,
    vimLabel: theme.vimBorder,
    zenLabel: theme.accent,
    titleLabel: theme.accent,
  });
  assert.match(zenOnly, /<acc>\[ZEN\]<\/acc>/);
  assert.match(zenOnly, /<acc>Agent-1<\/acc>/);
  assert.doesNotMatch(zenOnly, /<vim>/);
});

test("zen badge is dropped before title when width is tight", () => {
  const line = border({ width: 14, title: "Agent-1", zenMode: true });
  assert.equal([...line].length, 14);
  assert.doesNotMatch(line, /ZEN/);
  assert.match(line, /Agent-1/);
});

test("zen mode ignores tab-bar mouse clicks", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { title: "Alpha", zenMode: true });
  const second = createTab(2, "s2", "/repo", { title: "Beta" });
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  // Ghost hit geometry as if the bar were still painted at row 1.
  state.tabBarTopRow = 1;
  state.lastRenderWidth = 80;
  const regions = tabBarHitRegions(state, 80);
  const beta = regions.find((region) => region.id === "s2");
  assert.ok(beta, "hit-region math still exists; zen must ignore it");
  const mouseY = (state.tabBarTopRow ?? 1) + (beta.row ?? 0);
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  // Clicking Beta's ghost tab region must not switch away from Alpha.
  const result = handleMixCodeKeyInput(
    state,
    `\x1b[<0;${beta.startX};${mouseY}M`,
    tui,
  );
  assert.notEqual(state.activeTabId, "s2");
  assert.equal(first.zenMode, true);
  // May fall through to other handlers (selection/scroll); must not activate Beta.
  void result;
});

test("zen mode removes hidden tab-bar rows from extension overlay reservations", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    ...Array.from({ length: 8 }, (_, index) =>
      createTab(index + 1, `s${index + 1}`, "/repo", {
        title: `Long Agent Title ${index + 1}`,
      }),
    ),
  );
  state.activeTabId = "s1";
  let reservedRows: ((sessionId: string) => number) | undefined;
  const runtime = {
    getTab: () => ({ chat: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
    setExtensionUiHost: (host?: {
      topReservedRows?: (sessionId: string) => number;
    }) => {
      reservedRows = host?.topReservedRows;
    },
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  try {
    const normalRows = reservedRows?.("s1") ?? 0;
    assert.ok(normalRows > 1, `expected a wrapped tab bar, got ${normalRows} row(s)`);

    state.tabs[0]!.zenMode = true;
    assert.equal(reservedRows?.("s1"), 0);
  } finally {
    tui.stop();
  }
});

test("zen mode hides the tab bar but keeps agent chrome", () => {
  const runtime = {
    getTab: () => ({ chat: [{ role: "assistant", text: "chat-line" }] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;

  function render(zenMode: boolean): string {
    const state = createInitialState("/repo");
    state.tabs.push(
      createTab(1, "s1", "/repo", { title: "Alpha", zenMode }),
      createTab(2, "s2", "/repo", { title: "Beta" }),
    );
    state.activeTabId = "s1";
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    try {
      return tui.render(80).map(stripAnsi).join("\n");
    } finally {
      tui.stop();
    }
  }

  const normal = render(false);
  const zen = render(true);

  // Normal agent view shows the sibling tab label in the tab bar.
  assert.match(normal, /Beta/);
  assert.match(normal, /MixCode Home/);

  // Zen drops the tab bar (Home / sibling labels) while keeping agent title.
  assert.doesNotMatch(zen, /MixCode Home/);
  assert.doesNotMatch(zen, /Beta/);
  assert.match(zen, /Alpha/);
  assert.match(zen, /\[ZEN\]/);
});

test("zen mode swallows tab and shift-tab without switching agents", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { zenMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\t", tui, undefined, undefined, undefined, () => false),
    { consume: true },
  );
  assert.equal(state.activeTabId, "s1");
  assert.equal(first.zenMode, true);
  assert.equal(second.zenMode, false);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
});

// Zen already refuses Tab tab-switching; when an extension owns the editor,
// swallow is wasteful — pass Tab through so the component can use it.
test("zen mode passes tab through while an extension owns the editor slot", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { zenMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => "",
    setText: () => undefined,
    hasEditorReplacement: () => true,
  };

  assert.equal(
    handleMixCodeKeyInput(
      state,
      "\t",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
    "Tab must reach the extension component",
  );
  assert.equal(state.activeTabId, "s1");

  assert.equal(
    handleMixCodeKeyInput(
      state,
      "\x1b[Z",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
    "Shift+Tab must reach the extension component",
  );
  assert.equal(state.activeTabId, "s1");
});

test("zen + vim still swallows tab (zen wins over vim tab cycle)", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { zenMode: true, vimMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
  assert.equal(first.vimMode, true);
  assert.equal(first.zenMode, true);
  assert.equal(second.vimMode, false);
  assert.equal(second.zenMode, false);
});

test("ctrl-t tab jump transfers zen mode to the selected agent", () => {
  const state = createInitialState("/repo");
  const alpha = createTab(1, "s1", "/repo", { title: "Alpha", zenMode: true });
  const beta = createTab(2, "s2", "/repo", { title: "Beta" });
  state.tabs.push(alpha, beta);
  state.activeTabId = "s1";

  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true }); // Ctrl+T
  assert.equal(state.tabJumpOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "B", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(alpha.zenMode, false);
  assert.equal(beta.zenMode, true);
  assert.equal(state.tabJumpOpen, false);
});

test("tab jump to Home preserves zen mode on the agent", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { zenMode: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true }); // Up → Home
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.activeTabId, "config");
  assert.equal(tab.zenMode, true);
});

test("Home attach transfers zen mode to the selected agent", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { zenMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 1;

  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, undefined, undefined, () => false, {
      getText: () => "",
      setText: () => undefined,
    }),
    { consume: true },
  );
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.zenMode, false);
  assert.equal(second.zenMode, true);
});

test("from Home, Tab activates agent and keeps zen from the source agent", () => {
  // Bug: while on Home activeTabId is config, so transfer keyed only on the
  // previous active tab never saw zenMode and left the destination non-zen.
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { zenMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const emptyEditor = {
    getText: () => "",
    setText: () => undefined,
  };

  // Tab from Home → first agent; zen stays on first (already owner).
  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
  assert.equal(first.zenMode, true);
  assert.equal(second.zenMode, false);

  // Left → Home (zen remains on first).
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, emptyEditor),
    { consume: true },
  );
  assert.equal(state.activeTabId, "config");
  assert.equal(first.zenMode, true);

  // Shift+Tab from Home → last agent; zen must transfer s1 → s2.
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.zenMode, false);
  assert.equal(second.zenMode, true);
});

test("zenUnreadDoneCount excludes the active tab", () => {
  const tabs = [
    { sessionId: "s1", unreadDone: true },
    { sessionId: "s2", unreadDone: true },
    { sessionId: "s3", unreadDone: false },
  ];
  assert.equal(zenUnreadDoneCount(tabs, "s1"), 1);
  assert.equal(zenUnreadDoneCount(tabs, "s3"), 2);
  assert.equal(zenUnreadDoneCount(tabs, undefined), 2);
});

test("zen separator left-anchors ● dots and caps at 5 with [+N]", () => {
  const width = 40;
  const bare = (count: number) =>
    stripAnsi(
      renderTabBarSeparator(width, { zenMode: true, zenDoneCount: count })[0]!,
    );

  assert.equal(bare(0), "\u2500".repeat(width));
  assert.match(bare(1), /^── ● ─/);
  assert.doesNotMatch(bare(1), /\[\+/);
  assert.match(bare(2), /^── ● ● ─/);
  assert.match(bare(5), /^── ● ● ● ● ● ─/);
  assert.doesNotMatch(bare(5), /\[\+/);
  assert.match(bare(7), /^── ● ● ● ● ● \[\+2\] ─/);

  for (const count of [0, 1, 2, 5, 7]) {
    assert.equal([...bare(count)].length, width, `width must stay exact for count=${count}`);
  }
});

test("non-zen separator never shows done dots", () => {
  const line = stripAnsi(
    renderTabBarSeparator(40, { zenMode: false, zenDoneCount: 3 })[0]!,
  );
  assert.equal(line, "\u2500".repeat(40));
  assert.doesNotMatch(line, /●/);
});

test("zen done dots use done color while dashes use the frame color", () => {
  // Real SGR so visibleWidth/padLine ignore wrappers (fake <d> tags would be measured).
  const esc = "\x1b";
  const theme = {
    vimBorder: (s: string) => `${esc}[36m${s}${esc}[39m`,
    thinkingBorder: () => (s: string) => `${esc}[36m${s}${esc}[39m`,
    done: (s: string) => `${esc}[32m${s}${esc}[39m`,
    text: (s: string) => s,
  } as unknown as MixCodeTheme;
  const line = renderTabBarSeparator(
    40,
    { zenMode: true, zenDoneCount: 7, vimMode: true },
    theme,
  )[0]!;
  // "── ● ● ● ● ● [+2] " = 18 cols → 22 fill dashes on width 40.
  assert.equal(stripAnsi(line), "── ● ● ● ● ● [+2] " + "\u2500".repeat(22));
  // Dots and [+N] are green (32); lead/fill dashes are cyan frame (36).
  assert.ok(line.includes(`${esc}[32m● ● ● ● ●${esc}[39m`));
  assert.ok(line.includes(`${esc}[32m[+2]${esc}[39m`));
  assert.ok(line.includes(`${esc}[36m──${esc}[39m`));
  assert.ok(line.includes(`${esc}[36m`) && line.includes("─"));
});

test("zen separator drops dots when the row is too narrow", () => {
  const line = stripAnsi(
    renderTabBarSeparator(4, { zenMode: true, zenDoneCount: 3 })[0]!,
  );
  assert.equal(line, "────");
  assert.doesNotMatch(line, /●/);
});

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    clear: () => undefined,
    write: () => undefined,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
  } as unknown as Terminal;
}
