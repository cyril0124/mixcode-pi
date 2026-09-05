import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ChatLine, RuntimeTab } from "../src/agent/runtime.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { activateTab } from "../src/core/tabs.js";
import { MixCodeRoot } from "../src/ui/app-layout.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { testTui } from "./helpers/tui.js";

function setup() {
  const state = createInitialState("/repo");
  const tab = createTab(1, "scrollbar-1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const chat: ChatLine[] = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant",
    text: `row-${index} ${"content ".repeat(6)}`,
  }));
  let renders = 0;
  let overlay = false;
  const tui = testTui({ requestRender: () => renders++, hasOverlay: () => overlay });
  const runtime = testRuntime({ getTab: () => ({ chat }) as RuntimeTab });
  const root = new MixCodeRoot(
    state,
    runtime,
    () => 24,
    () => 2,
    undefined,
    undefined,
    tui,
  );
  const render = () => root.render(80);
  render();
  const mouse = (button: number, x: number, y: number, release = false) =>
    handleMixCodeKeyInput(state, `\x1b[<${button};${x};${y}${release ? "m" : "M"}`, tui);
  const bounds = () => tab.chatSurfaceBounds!;
  const gutter = () => {
    const lines = render();
    const b = bounds();
    return lines
      .slice(b.top - 1, b.top - 1 + b.height)
      .map((line) => stripTerminalSequences(sliceByColumn(line, b.left + b.width - 1, 1)));
  };
  return {
    state,
    tab,
    chat,
    root,
    tui,
    render,
    mouse,
    bounds,
    gutter,
    renders: () => renders,
    setOverlay: (value: boolean) => {
      overlay = value;
    },
  };
}

test("chat scrollbar stays visible while idle and only changes thickness on hover", async () => {
  const f = setup();
  assert.ok(f.gutter().includes("┃"));
  const before = [...f.tab.lastRenderedChatLines!];
  const b = f.bounds();
  f.mouse(35, b.left + b.width, b.top + 2);
  assert.ok(f.gutter().includes("█"));
  await Bun.sleep(1100);
  assert.ok(f.gutter().includes("█"));
  f.mouse(35, 4, b.top + 2);
  assert.ok(f.gutter().includes("┃"));
  const renders = f.renders();
  await Bun.sleep(1100);
  assert.equal(f.renders(), renders);
  assert.ok(f.gutter().includes("┃"));
  assert.deepEqual(f.tab.lastRenderedChatLines, before);
});

test("thumb press preserves position and dragging continues outside the gutter until release", () => {
  const f = setup();
  const b = f.bounds();
  const x = b.left + b.width;
  f.mouse(35, x, b.top);
  const bar = f.gutter();
  const thumbRow = b.top + bar.lastIndexOf("█");
  const before = f.tab.chatScrollOffset;
  f.mouse(0, x, thumbRow);
  f.render();
  assert.equal(f.tab.chatScrollOffset, before);
  f.mouse(32, x - 5, thumbRow - 5);
  f.render();
  assert.ok(f.tab.chatScrollOffset > before);
  assert.equal(f.tab.chatSelection, undefined);
  f.mouse(0, x - 5, thumbRow - 5, true);
  const released = f.tab.chatScrollOffset;
  f.mouse(32, x - 5, b.top);
  f.render();
  assert.equal(f.tab.chatScrollOffset, released);
  assert.equal(f.tab.chatSelection, undefined);
});

test("unrelated hover motion neither repaints nor cancels the enter-Vim chord", () => {
  const f = setup();
  let draft = "";
  handleMixCodeKeyInput(f.state, "\x15", f.tui, undefined, undefined, undefined, undefined, {
    getText: () => draft,
    setText: (text) => {
      draft = text;
    },
  });
  const before = f.renders();
  for (let x = 2; x < 20; x++) f.mouse(35, x, f.bounds().top + 2);
  assert.equal(f.renders(), before);
  handleMixCodeKeyInput(f.state, "u", f.tui);
  assert.equal(f.tab.vimMode, true);
});

test("keyboard scrolling keeps a thin scrollbar and switching tabs cancels pointer capture", () => {
  const f = setup();
  handleMixCodeKeyInput(f.state, "\x1b[5~", f.tui);
  assert.ok(f.gutter().includes("┃"));
  const b = f.bounds();
  f.mouse(35, b.left + b.width, b.top);
  const thumbRow = b.top + f.gutter().indexOf("█");
  f.mouse(0, b.left + b.width, thumbRow);
  const second = createTab(2, "scrollbar-2", "/repo");
  f.state.tabs.push(second);
  activateTab(f.state, second.sessionId);
  f.render();
  activateTab(f.state, f.tab.sessionId);
  f.render();
  const offset = f.tab.chatScrollOffset;
  f.mouse(32, b.left + b.width, b.top + b.height - 1);
  f.render();
  assert.equal(f.tab.chatScrollOffset, offset);
});

test("a modal cancels scrollbar capture and does not allow scrolling underneath", () => {
  const f = setup();
  const b = f.bounds();
  f.mouse(35, b.left + b.width, b.top);
  f.mouse(0, b.left + b.width, b.top + f.gutter().lastIndexOf("█"));
  f.setOverlay(true);
  f.render();
  const offset = f.tab.chatScrollOffset;
  f.mouse(32, b.left + b.width, b.top);
  assert.equal(f.tab.chatScrollOffset, offset);
  f.setOverlay(false);
  f.render();
  f.mouse(32, b.left + b.width, b.top);
  assert.equal(f.tab.chatScrollOffset, offset);
});
