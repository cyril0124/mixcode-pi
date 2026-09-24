import assert from "node:assert/strict";
import { test } from "node:test";
import {
  stripTerminalSequences,
  visibleWidth,
  TuiMainScreen,
  type Terminal,
} from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import {
  openCommandPalette,
  closeCommandPalette,
  openTabJump,
  scrollChat,
} from "../src/core/overlays.js";
import { closeAppOverlay, showComponentOverlay } from "../src/ui/app-overlays.js";
import {
  planCommandPaletteList,
  planTabJumpList,
  renderCommandPalette,
  renderTabJumpOverlay,
} from "../src/ui/rendering/overlays.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { activeRenderTheme } from "../src/ui/rendering/context.js";
import { startScrollableChatSelection } from "../src/core/chat-selection.js";
import type { RuntimeTab } from "../src/agent/runtime.js";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { PointerHover } from "../src/ui/pointer-hover.js";
import { themeForId } from "../src/ui/themes.js";
import { renderTabBar, renderInputMeta, tabBarHitRegions } from "../src/ui/rendering/chrome.js";
import { testTui } from "./helpers/tui.js";

for (const scope of ["command-palette", "tab-jump"] as const) {
  test(`${scope} yields pointer input to a focused extension overlay and resumes after close`, async (t) => {
    const state = createInitialState("/repo");
    const painted = Promise.withResolvers<void>();
    let sendInput: ((data: string) => void) | undefined;
    const terminal: Terminal = {
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      start: (onInput) => {
        sendInput = onInput;
      },
      stop: () => undefined,
      drainInput: async () => undefined,
      write: () => painted.resolve(),
      moveBy: () => undefined,
      hideCursor: () => undefined,
      showCursor: () => undefined,
      clearLine: () => undefined,
      clearFromCursor: () => undefined,
      clearScreen: () => undefined,
      setTitle: () => undefined,
      setProgress: () => undefined,
    };
    const tui = new TuiMainScreen(terminal);
    t.after(() => {
      closeAppOverlay(tui);
      tui.stop();
    });
    tui.addInputListener((data) => handleMixCodeKeyInput(state, data, tui));
    tui.start();
    if (scope === "command-palette") openCommandPalette(state);
    else openTabJump(state);
    const render = (width: number) =>
      scope === "command-palette"
        ? renderCommandPalette(state, width)
        : renderTabJumpOverlay(state, width);
    const host = showComponentOverlay(tui, { render, invalidate: () => undefined });
    await painted.promise;
    const bounds = host?.getBounds();
    assert.ok(bounds);
    assert.ok(sendInput);
    const plan =
      scope === "command-palette" ? planCommandPaletteList(state) : planTabJumpList(state);
    const data = mouse(bounds.col + 2, bounds.row + plan.entryBodyLines[0]!.bodyLine + 2);
    sendInput(data);
    assert.ok(render(bounds.width).some((line) => line.includes("\x1b[4m")));

    const received: string[] = [];
    const extension = tui.showOverlay({
      render: () => ["Extension controls"],
      handleInput: (data) => {
        received.push(data);
      },
      invalidate: () => undefined,
    });
    assert.equal(host?.isFocused(), false);
    assert.equal(extension.isFocused(), true);
    sendInput(data);
    assert.deepEqual(received, [data], "the focused extension must receive mouse movement");
    assert.equal(
      render(bounds.width).some((line) => line.includes("\x1b[4m")),
      false,
    );

    extension.hide();
    assert.equal(host?.isFocused(), true);
    sendInput(data);
    assert.ok(render(bounds.width).some((line) => line.includes("\x1b[4m")));
    assert.deepEqual(received, [data]);
  });
}

function mouse(x: number, y: number) {
  return `\x1b[<35;${x};${y}M`;
}

/** The background the cue paints a hovered tool block with; the selection shares it. */
function cueBackground(): string {
  return activeRenderTheme.selectedBg("\u0001").split("\u0001")[0]!;
}

test("hovering rendered tabs changes appearance without activating or repainting the same target", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "first", "/repo"), createTab(2, "second", "/repo"));
  state.activeTabId = "first";
  state.tabs.forEach((tab) => {
    tab.activatedAt = Date.now() - 2500;
  });
  let renders = 0;
  const tui = testTui({ requestRender: () => renders++ });
  const normal = renderTabBar(state, 100);
  const target = tabBarHitRegions(state, 100).find((region) => region.id === "second")!;
  handleMixCodeKeyInput(state, mouse(target.startX, 1), tui);
  const hovered = renderTabBar(state, 100);
  assert.notDeepEqual(hovered, normal);
  assert.deepEqual(hovered.map(stripTerminalSequences), normal.map(stripTerminalSequences));
  assert.equal(state.activeTabId, "first");
  const count = renders;
  for (let i = 0; i < 1000; i++) handleMixCodeKeyInput(state, mouse(target.startX + 1, 1), tui);
  assert.equal(renders, count);
  handleMixCodeKeyInput(state, mouse(100, 20), tui);
  assert.deepEqual(renderTabBar(state, 100), normal);
});

test("metadata hover follows each click region and is blocked by Home and overlays", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "first", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const tui = testTui();
  const render = () => renderInputMeta(tab, 140, 30);
  const normal = render();
  for (const region of tab.inputMetaHitRegions!) {
    handleMixCodeKeyInput(state, mouse(region.startX, region.row), tui);
    const hovered = render();
    assert.notDeepEqual(hovered, normal, region.action);
    assert.deepEqual(hovered.map(stripTerminalSequences), normal.map(stripTerminalSequences));
    assert.equal(state.picker, undefined);
    openCommandPalette(state);
    handleMixCodeKeyInput(state, mouse(region.startX, region.row), tui);
    assert.deepEqual(render(), normal);
    closeCommandPalette(state);
    state.activeTabId = "home";
    handleMixCodeKeyInput(state, mouse(region.startX, region.row), tui);
    assert.deepEqual(render(), normal);
    state.activeTabId = tab.sessionId;
  }
});

test("wrapped tabs and pinned Home hover use the same geometry as clicks", (t) => {
  // Keep the active-label shimmer identical across hover and resize renders.
  t.mock.method(Date, "now", () => 0);
  const state = createInitialState("/repo");
  for (let i = 1; i <= 16; i++) state.tabs.push(createTab(i, `s${i}`, "/repo", { activatedAt: 0 }));
  state.activeTabId = "s12";
  state.tabBarTopRow = 3;
  const tui = testTui();
  const normal = renderTabBar(state, 36, undefined, 3);
  const regions = tabBarHitRegions(state, 36, 3);
  for (const region of [regions[0]!, regions.find((region) => (region.row ?? 0) > 0)!]) {
    assert.ok(region);
    handleMixCodeKeyInput(state, mouse(region.startX, (region.row ?? 0) + 3), tui);
    const hovered = renderTabBar(state, 36, undefined, 3);
    assert.notDeepEqual(hovered, normal);
    assert.deepEqual(hovered.map(stripTerminalSequences), normal.map(stripTerminalSequences));
    assert.equal(state.activeTabId, "s12");
  }
  renderTabBar(state, 100, undefined, 1);
  assert.deepEqual(renderTabBar(state, 36, undefined, 3), normal, "resizing cancels stale hover");
});

test("jump hover changes only its label and leaves scrolling and transcript selection intact", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "jump", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtimeTab = {
    chat: Array.from({ length: 12 }, (_, i) => ({ role: "user", text: `message ${i}` })),
  } as RuntimeTab;
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 79, height: 12 };
  scrollChat(tab, 10);
  const render = () => renderAgentSurface(tab, runtimeTab, 80, 12);
  const normal = render();
  const region = tab.chatJumpToLatestHitRegion!;
  assert.ok(region);
  const offset = tab.chatScrollOffset;
  let requests = 0;
  const tui = testTui({
    requestRender: () => {
      requests++;
    },
  });
  handleMixCodeKeyInput(state, mouse(region.column + 1, region.row + 5), tui);
  const hover = render();
  assert.notDeepEqual(hover, normal);
  assert.deepEqual(hover.map(stripTerminalSequences), normal.map(stripTerminalSequences));
  assert.equal(tab.chatScrollOffset, offset);
  assert.equal(tab.chatSelection, undefined);
  const count = requests;
  handleMixCodeKeyInput(state, mouse(region.column + 2, region.row + 5), tui);
  assert.equal(requests, count);
  handleMixCodeKeyInput(state, mouse(1, 2), tui);
  assert.deepEqual(render(), normal);
});

test("hover paint preserves wide cells, resets with geometry, and never alters the source", () => {
  const hover = new PointerHover();
  const source = ["  模型 name  rest"];
  hover.layout([{ id: "model", x: 3, y: 1, width: 9 }]);
  assert.equal(hover.move(4, 1), true);
  for (const theme of ["mixcode-dark", "light", "terminal"]) {
    const painted = hover.paint(source, visibleWidth(source[0]!), themeForId(theme));
    assert.equal(stripTerminalSequences(painted[0]!), source[0]);
    assert.notEqual(painted[0], source[0]);
    const suffix = sliceByColumn(painted[0]!, 12, 4, true);
    const styles = [...suffix.matchAll(/\x1b\[(0|4|24)m/g)].map((match) => match[1]);
    assert.ok(
      styles.at(-1) === "0" || styles.at(-1) === "24",
      "adjacent cells must end underline before painting their text",
    );
  }
  assert.equal(source[0], "  模型 name  rest");
  hover.layout([{ id: "model", x: 4, y: 1, width: 9 }]);
  assert.equal(hover.id, undefined);
  assert.deepEqual(hover.paint(source, 20, themeForId("light")), source);
});

test("hovering and clicking a tool row act on that call only", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "tool-click", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtimeTab = {
    chat: [
      { role: "user", text: "run the checks" },
      { role: "tool", toolCallId: "call-1", title: "bash", text: "$ bun run check" },
      { role: "tool", toolCallId: "call-2", title: "bash", text: "$ bun run lint" },
      { role: "assistant", text: "done" },
    ],
  } as RuntimeTab;
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 79, height: 12 };
  const render = () => renderAgentSurface(tab, runtimeTab, 80, 12);
  const normal = render();
  const ranges = tab.chatToolRowRanges;
  assert.ok(
    ranges && ranges.length === 2,
    `both tool blocks are published: ${JSON.stringify(ranges)}`,
  );
  const [first, second] = ranges as Array<{ start: number; height: number; toolCallId?: string }>;
  assert.deepEqual(
    [first!.toolCallId, second!.toolCallId],
    ["call-1", "call-2"],
    "each range carries its own tool call",
  );
  const tui = testTui({ requestRender: () => {} });
  // The published range has to cover rows the renderer actually painted for that block.
  const blockRows = normal
    .slice(first!.start, first!.start + first!.height)
    .map(stripTerminalSequences);
  assert.ok(
    blockRows.some((row) => row.includes("bash")),
    `the range covers the block's own rows: ${blockRows.join(" | ")}`,
  );

  // Hover paints the pointed row's block.
  handleMixCodeKeyInput(state, `\x1b[<35;4;${5 + first!.start}M`, tui);
  const hovered = render();
  assert.notDeepEqual(hovered, normal, "the pointed block is highlighted");
  assert.deepEqual(hovered.map(stripTerminalSequences), normal.map(stripTerminalSequences));
  handleMixCodeKeyInput(state, `\x1b[<35;4;1M`, tui);
  assert.deepEqual(render(), normal, "leaving the chat clears the cue");

  // A click expands only the call it landed on.
  handleMixCodeKeyInput(state, `\x1b[<0;4;${5 + first!.start}M`, tui);
  assert.equal(tab.extensionUi.toolsExpanded, false, "the press alone changes nothing");
  handleMixCodeKeyInput(state, `\x1b[<0;4;${5 + first!.start}m`, tui);
  assert.deepEqual([...(tab.expandedToolCalls ?? [])], ["call-1"]);
  assert.equal(tab.extensionUi.toolsExpanded, false, "the global toggle stays off");

  // Clicking the second row expands that one too, and re-clicking the first collapses it.
  const secondRow = 5 + second!.start;
  handleMixCodeKeyInput(state, `\x1b[<0;4;${secondRow}M`, tui);
  handleMixCodeKeyInput(state, `\x1b[<0;4;${secondRow}m`, tui);
  assert.deepEqual([...(tab.expandedToolCalls ?? [])].sort(), ["call-1", "call-2"]);
  const firstRow = 5 + first!.start;
  handleMixCodeKeyInput(state, `\x1b[<0;4;${firstRow}M`, tui);
  handleMixCodeKeyInput(state, `\x1b[<0;4;${firstRow}m`, tui);
  assert.deepEqual([...(tab.expandedToolCalls ?? [])], ["call-2"]);

  // A drag over a row is a text selection, not a click.
  handleMixCodeKeyInput(state, `\x1b[<0;4;${secondRow}M`, tui);
  handleMixCodeKeyInput(state, `\x1b[<32;9;${secondRow}M`, tui);
  handleMixCodeKeyInput(state, `\x1b[<0;9;${secondRow}m`, tui);
  assert.deepEqual([...(tab.expandedToolCalls ?? [])], ["call-2"], "a drag never toggles");

  // A click on a row that holds no tool call leaves the state alone.
  handleMixCodeKeyInput(state, "\x1b[<0;4;5M", tui);
  handleMixCodeKeyInput(state, "\x1b[<0;4;5m", tui);
  assert.deepEqual([...(tab.expandedToolCalls ?? [])], ["call-2"]);
});

test("tool-row pointer feedback covers only agent tool rows and follows the press", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "tool-pointer", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtimeTab = {
    chat: [
      { role: "user", text: "run the checks" },
      { role: "tool", toolCallId: "call-1", title: "bash", text: "$ bun run check" },
      {
        role: "tool",
        toolCallId: "user-bash-1",
        variant: "user-bash",
        title: "bash",
        text: "$ echo hi",
      },
      { role: "assistant", text: "done" },
    ],
  } as RuntimeTab;
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 79, height: 12 };
  const render = () => renderAgentSurface(tab, runtimeTab, 80, 12);
  render();
  assert.equal(tab.chatHoverRow, undefined, "a fresh render carries no cue");

  const ranges = tab.chatToolRowRanges ?? [];
  assert.deepEqual(
    ranges.map((range) => range.toolCallId),
    ["call-1"],
    "a command the user typed answers no pointer",
  );
  const row = 5 + ranges[0]!.start;
  const tui = testTui({ requestRender: () => {} });

  // The chat's own columns bound the cue, so the scrollbar column stays inert.
  handleMixCodeKeyInput(state, mouse(1 + 79, row), tui);
  assert.equal(tab.chatHoverRow, undefined);
  handleMixCodeKeyInput(state, mouse(4, row), tui);
  assert.equal(tab.chatHoverRow, ranges[0]!.start);

  // A row outside a tool block and an overlay both drop the cue.
  handleMixCodeKeyInput(state, mouse(4, 5 + 10), tui);
  assert.equal(tab.chatHoverRow, undefined, "motion off the tool row drops the cue");
  handleMixCodeKeyInput(state, mouse(4, row), tui);
  const covered = testTui({ requestRender: () => {}, hasOverlay: () => true });
  handleMixCodeKeyInput(state, mouse(4, row), covered);
  assert.equal(tab.chatHoverRow, undefined, "an overlay owns the pointer");

  // The press keeps its call, so a scroll before the release still toggles that call.
  handleMixCodeKeyInput(state, `\x1b[<0;4;${row}M`, tui);
  handleMixCodeKeyInput(state, "\x1b[<64;4;6M", tui);
  handleMixCodeKeyInput(state, `\x1b[<0;4;${row}m`, tui);
  assert.deepEqual([...(tab.expandedToolCalls ?? [])], ["call-1"]);
  // That release never reached the selection handler, so no drag state may survive it.
  assert.equal(tab.chatSelection, undefined, "a click leaves no drag behind");
});

test("a selection inside a hovered tool block is underlined and keeps the cue", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "selection", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const toolCall = (id: string) => ({
    role: "tool" as const,
    title: "bash",
    toolCallId: id,
    status: "success" as const,
    text: `output ${id}`,
    args: { command: `echo ${id}` },
  });
  const runtimeTab = {
    chat: [
      { role: "user", text: "before" },
      toolCall("t-1"),
      toolCall("t-2"),
      { role: "user", text: "after" },
    ],
  } as unknown as RuntimeTab;
  // Styles carry both cues, so these comparisons stay on the raw lines.
  const render = () => renderAgentSurface(tab, runtimeTab, 80, 20);
  const plain = render();
  const ranges = tab.chatToolRowRanges ?? [];
  const block = ranges.find((range) => range.toolCallId === "t-1");
  assert.ok(block, "the tool rows published their ranges");
  // The block's output row: nothing there carries an underline to begin with.
  const textRow = plain.findIndex(
    (line, row) =>
      row >= block.start &&
      row < block.start + block.height &&
      stripTerminalSequences(line).includes("output"),
  );
  // The block's other text row, which the drag below never reaches.
  const commandRow = plain.findIndex(
    (line, row) =>
      row >= block.start &&
      row < block.start + block.height &&
      row !== textRow &&
      stripTerminalSequences(line).trim().length > 0,
  );
  assert.ok(textRow >= block.start && commandRow >= block.start, "the block has both text rows");
  const cells = (lines: string[]) => sliceByColumn(lines[textRow]!, 1, 6, true);

  tab.chatHoverRow = block.start;
  const hovered = render();
  assert.notDeepEqual(hovered, plain, "a hovered tool block is painted");
  assert.ok(hovered[textRow]!.includes(cueBackground()), "the cue paints the pointer's block");
  assert.ok(
    !cells(plain).includes("\u001b[4m"),
    "no cell of the block is underlined to begin with",
  );

  tab.chatSelection = {
    anchor: { row: textRow, col: 1 },
    focus: { row: textRow, col: 7 },
    dragging: true,
  };
  startScrollableChatSelection(
    tab.chatSelection,
    tab.lastRenderedChatLines ?? [],
    tab.chatScrollOffset,
  );
  const selected = render();
  assert.ok(cells(selected).includes("\u001b[4m"), "the selected cells are underlined");
  // The underline run covers the selected text and stops there.
  const open = selected[textRow]!.lastIndexOf("\u001b[4m");
  const close = selected[textRow]!.indexOf("\u001b[24m", open);
  assert.equal(
    stripTerminalSequences(selected[textRow]!.slice(open, close)).trim(),
    "output",
    "the underline covers the selected cells only",
  );
  // A block row the drag never reached still answers the pointer.
  assert.ok(
    selected[commandRow]!.includes(cueBackground()),
    "the cue stays on the block rows outside the selection",
  );

  tab.chatSelection = undefined;
  assert.ok(!cells(render()).includes("\u001b[4m"), "clearing the selection drops the underline");
});

test("a selection outside a tool block keeps the plain background", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "plain", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtimeTab = {
    chat: [
      { role: "user", text: "a plain user line" },
      {
        role: "tool",
        title: "bash",
        toolCallId: "t-1",
        status: "success",
        text: "output t-1",
        args: { command: "echo one" },
      },
    ],
  } as unknown as RuntimeTab;
  const render = () => renderAgentSurface(tab, runtimeTab, 80, 20);
  const plain = render();
  const block = (tab.chatToolRowRanges ?? []).find((range) => range.toolCallId === "t-1");
  assert.ok(block);
  const userRow = plain.findIndex((line) =>
    stripTerminalSequences(line).includes("a plain user line"),
  );
  const outputRow = plain.findIndex(
    (line, row) =>
      row >= block.start &&
      row < block.start + block.height &&
      stripTerminalSequences(line).includes("output"),
  );
  assert.ok(userRow >= 0 && userRow < outputRow, "the user line sits above the block's output row");

  // One drag from the user line into the block covers rows of both kinds.
  tab.chatSelection = {
    anchor: { row: userRow, col: 1 },
    focus: { row: outputRow, col: 7 },
    dragging: true,
  };
  startScrollableChatSelection(
    tab.chatSelection,
    tab.lastRenderedChatLines ?? [],
    tab.chatScrollOffset,
  );
  const selected = render();
  const userCells = sliceByColumn(selected[userRow]!, 1, 12, true);
  const outputCells = sliceByColumn(selected[outputRow]!, 1, 6, true);
  assert.ok(userCells.includes(cueBackground()), "the selection paints the user line");
  assert.ok(!userCells.includes("\u001b[4m"), "no underline outside a tool block");
  assert.ok(
    outputCells.includes("\u001b[4m"),
    "the same drag underlines the block rows it reaches",
  );
});

test("a scrolled frame paints the selection where the mapped rows land", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "scrolled", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtimeTab = {
    chat: [
      ...Array.from({ length: 40 }, (_, index) => ({
        role: "user" as const,
        text: `line ${index}`,
      })),
      {
        role: "tool" as const,
        title: "bash",
        toolCallId: "t-last",
        status: "success" as const,
        text: "output",
        args: { command: "echo last" },
      },
    ],
  } as unknown as RuntimeTab;
  const render = () => renderAgentSurface(tab, runtimeTab, 80, 12);
  const first = render();
  const range = (tab.chatToolRowRanges ?? []).find((entry) => entry.toolCallId === "t-last");
  assert.ok(range, "the trailing tool row is visible at the tail");
  const textRow = first.findIndex(
    (line, row) =>
      row >= range.start &&
      row < range.start + range.height &&
      stripTerminalSequences(line).trim().length > 0,
  );
  assert.ok(textRow >= range.start, "the block has a row with text");
  const origin = tab.chatScrollOffset;
  tab.chatSelection = {
    anchor: { row: textRow, col: 1 },
    focus: { row: textRow, col: 7 },
    dragging: true,
  };
  // The drag registered its rows in the frame it started in; scrolling moves the text under it.
  startScrollableChatSelection(tab.chatSelection, tab.lastRenderedChatLines ?? [], origin);
  scrollChat(tab, 2);
  const withSelection = render();
  const moved = (tab.chatToolRowRanges ?? []).find((entry) => entry.toolCallId === "t-last");
  assert.ok(moved);
  assert.notEqual(tab.chatScrollOffset, origin, "the frame really scrolled");
  assert.notEqual(moved.start, range.start, "the block moved with the frame");
  const movedRow = withSelection.findIndex(
    (line, row) =>
      row >= moved.start &&
      row < moved.start + moved.height &&
      stripTerminalSequences(line).trim().length > 0,
  );
  assert.ok(movedRow >= moved.start, "the moved block has a row with text");
  const keptSelection = tab.chatSelection;
  tab.chatSelection = undefined;
  const withoutSelection = render();
  tab.chatSelection = keptSelection;
  assert.ok(
    !sliceByColumn(withoutSelection[movedRow]!, 1, 6, true).includes(cueBackground()),
    "nothing paints those cells without a selection",
  );
  assert.ok(
    sliceByColumn(withSelection[movedRow]!, 1, 6, true).includes(cueBackground()),
    "the selection follows the block into the scrolled frame",
  );
});
