import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth, type OverlayBounds } from "@earendil-works/pi-tui";
import {
  handleListOverlayMouse,
  setListOverlayHover,
  type ListOverlayPlan,
} from "../src/ui/components/list-overlay-mouse.js";
import {
  planCommandPaletteList,
  planTabJumpList,
  renderCommandPalette,
  renderTabJumpOverlay,
} from "../src/ui/rendering/overlays.js";
import {
  createInitialState,
  createTab,
  openCommandPalette,
  openTabJump,
  updateCommandPaletteQuery,
  updateTabJumpQuery,
} from "./helpers/mixcode.js";

const motion = (x: number, y: number) => `\x1b[<35;${x};${y}M`;

for (const kind of ["command-palette", "tab-jump"] as const) {
  function setup() {
    const state = createInitialState("/repo");
    state.tabs.push(
      createTab(1, "s1", "/repo", { title: "alpha" }),
      createTab(2, "s2", "/repo", { title: "beta" }),
    );
    if (kind === "command-palette") openCommandPalette(state);
    else openTabJump(state);
    const plan = (): ListOverlayPlan =>
      kind === "command-palette" ? planCommandPaletteList(state) : planTabJumpList(state);
    const render = (width = 60) =>
      kind === "command-palette"
        ? renderCommandPalette(state, width)
        : renderTabJumpOverlay(state, width);
    const baseline = render();
    let bounds: OverlayBounds | undefined = { col: 5, row: 3, width: 60, height: baseline.length };
    let renders = 0;
    let reshows = 0;
    const accepted: number[] = [];
    const moved: number[] = [];
    const input = (data: string) =>
      handleListOverlayMouse(data, {
        plan,
        isOpen: () => (kind === "command-palette" ? state.commandPaletteOpen : state.tabJumpOpen),
        bounds: () => bounds,
        onMove: (delta) => moved.push(delta),
        onAccept: (index) => accepted.push(index),
        onHover: (mouse, bounds) => {
          if (setListOverlayHover(state, kind, mouse, bounds)) renders++;
        },
        reshow: () => reshows++,
      });
    return {
      state,
      plan,
      render,
      baseline,
      input,
      accepted,
      moved,
      setBounds: (value: OverlayBounds | undefined) => {
        bounds = value;
      },
      renders: () => renders,
      reshows: () => reshows,
    };
  }

  test(`${kind}: hover paints the whole clickable row without changing keyboard selection or recreating overlays`, () => {
    const view = setup();
    const hit = view.plan().entryBodyLines[1]!;
    const y = 3 + hit.bodyLine + 2;
    const selected = [view.state.commandPalette.selectedIndex, view.state.tabJumpIndex];
    view.input(motion(6, y));
    const hovered = view.render();
    assert.match(hovered[hit.bodyLine + 1]!, /\x1b\[4m/);
    assert.deepEqual(
      hovered.map(stripTerminalSequences),
      view.baseline.map(stripTerminalSequences),
    );
    assert.deepEqual(hovered.map(visibleWidth), view.baseline.map(visibleWidth));
    assert.equal(hovered.filter((line) => line.includes("\x1b[4m")).length, 1);
    view.input(motion(65, y));
    assert.equal(view.renders(), 1);
    assert.equal(view.reshows(), 0);
    assert.deepEqual([view.state.commandPalette.selectedIndex, view.state.tabJumpIndex], selected);
    assert.deepEqual(view.accepted, []);
    assert.deepEqual(view.moved, []);
    view.input(motion(66, y));
    assert.deepEqual(view.render(), view.baseline);
    assert.equal(view.renders(), 2);
  });

  test(`${kind}: headers, clipped rows and missing compositor bounds cannot hover`, () => {
    const view = setup();
    const hit = view.plan().entryBodyLines[0]!;
    const y = 3 + hit.bodyLine + 2;
    view.input(motion(8, y));
    view.input(motion(8, 5));
    assert.deepEqual(view.render(), view.baseline);
    view.setBounds({ col: 5, row: 3, width: 60, height: hit.bodyLine + 2 });
    view.input(motion(8, y));
    assert.deepEqual(view.render(), view.baseline);
    view.setBounds(undefined);
    view.input(motion(8, y));
    assert.deepEqual(view.render(), view.baseline);
  });

  test(`${kind}: keyboard, wheel and drag clear pointer focus while preserving existing input behavior`, () => {
    const view = setup();
    const hit = view.plan().entryBodyLines[0]!;
    const y = 3 + hit.bodyLine + 2;
    view.input(motion(8, y));
    assert.equal(view.input("\x1b[B"), false);
    assert.deepEqual(view.render(), view.baseline);
    view.input(motion(8, y));
    view.input(`\x1b[<65;8;${y}M`);
    assert.deepEqual(view.moved, [1]);
    assert.equal(view.reshows(), 1);
    assert.deepEqual(view.render(), view.baseline);
    view.input(motion(8, y));
    view.input(`\x1b[<32;8;${y}M`);
    assert.deepEqual(view.render(), view.baseline);
    view.input(`\x1b[<0;6;${y}M`);
    assert.deepEqual(view.accepted, [hit.entryIndex]);
  });

  test(`${kind}: scrolling and closure discard pointer focus`, () => {
    const view = setup();
    for (let index = 3; index < 80; index++) {
      view.state.tabs.push(createTab(index, `s${index}`, "/repo"));
    }
    view.render();
    const hit = view.plan().entryBodyLines[0]!;
    view.input(motion(8, 3 + hit.bodyLine + 2));
    if (kind === "command-palette") view.state.commandPalette.selectedIndex = 40;
    else view.state.tabJumpIndex = 40;
    assert.equal(
      view.render().some((line) => line.includes("\x1b[4m")),
      false,
    );
    const scrolledHit = view.plan().entryBodyLines[0]!;
    view.input(motion(8, 3 + scrolledHit.bodyLine + 2));
    if (kind === "command-palette") view.state.commandPaletteOpen = false;
    else view.state.tabJumpOpen = false;
    view.input(motion(8, 3 + scrolledHit.bodyLine + 2));
    if (kind === "command-palette") view.state.commandPaletteOpen = true;
    else view.state.tabJumpOpen = true;
    assert.equal(
      view.render().some((line) => line.includes("\x1b[4m")),
      false,
    );
  });

  test(`${kind}: query and width changes discard hover before another item can inherit it`, () => {
    const view = setup();
    const hit = view.plan().entryBodyLines[0]!;
    view.input(motion(8, 3 + hit.bodyLine + 2));
    if (kind === "command-palette") updateCommandPaletteQuery(view.state, "settings");
    else updateTabJumpQuery(view.state, "beta");
    assert.equal(
      view.render().some((line) => line.includes("\x1b[4m")),
      false,
    );
    const filteredHit = view.plan().entryBodyLines[0]!;
    view.input(motion(8, 3 + filteredHit.bodyLine + 2));
    assert.equal(
      view.render().some((line) => line.includes("\x1b[4m")),
      true,
    );
    assert.equal(
      view.render(40).some((line) => line.includes("\x1b[4m")),
      false,
    );
  });
}
