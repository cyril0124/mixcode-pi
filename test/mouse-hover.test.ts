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
