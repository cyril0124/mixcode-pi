import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  openCommandPalette,
  openTabJump,
  tabBarHitRegions,
} from "./helpers/mixcode.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { testOverlayHandle, testTui } from "./helpers/tui.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import {
  handleCommandPaletteMouse,
  handleMouseInput,
  handleTabJumpMouse,
} from "../src/ui/app-mouse.js";
import { resolveOverlayLayout } from "@earendil-works/pi-tui";
import { hitTestListOverlay } from "../src/ui/components/list-overlay-mouse.js";
import {
  closeAppOverlay,
  defaultOverlayOptions,
  getActiveNotice,
  hasAnyOverlay,
  showLinesOverlay,
  showNoticeTextOverlay,
} from "../src/ui/app-overlays.js";
import { planCommandPaletteList, planTabJumpList } from "../src/ui/rendering.js";

function setup() {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 20, height: 3 };
  tab.lastRenderedChatLines = ["hello world", "again there", "done"];
  let renders = 0;
  const tui = testTui({ requestRender: () => renders++ });
  return { state, tab, tui, renders: () => renders };
}

test("handleMouseInput drags and copies visible chat selection", async () => {
  const { state, tab, tui, renders } = setup();
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;7;5M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;6;6M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;6;6m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["world\nagain"]);
  assert.equal(tab.toast?.message, "Copied 11 chars.");
  assert.equal(tab.chatSelection, undefined);
  assert.ok(renders() >= 3);
});

async function waitFor(predicate: () => boolean, attempts = 250): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  assert.equal(predicate(), true);
}

test("handleMouseInput auto-scrolls a top-edge chat drag and copies off-screen rows", async () => {
  const { state, tab } = setup();
  const allLines = Array.from({ length: 8 }, (_, index) => `line-${index}`);
  const copied: string[] = [];
  const viewport = 3;
  const bottomStart = allLines.length - viewport;
  const render = () => {
    const start = Math.max(0, bottomStart - tab.chatScrollOffset);
    tab.lastRenderedChatLines = allLines.slice(start, start + viewport);
    tab.lastChatScrollMetrics = {
      total: allLines.length,
      viewport,
      start,
      end: start + viewport,
      scrollable: true,
    };
  };
  const tui = testTui({ requestRender: render });
  render();

  assert.equal(
    handleMouseInput(state, tab, "\x1b[<0;7;7M", tui, undefined, undefined, async (text) => {
      copied.push(text);
    }),
    true,
  );
  assert.equal(
    handleMouseInput(state, tab, "\x1b[<32;1;5M", tui, undefined, undefined, async (text) => {
      copied.push(text);
    }),
    true,
  );

  // Auto-scroll ticks every 50ms; poll instead of racing a fixed sleep so
  // loaded (parallel/CI) runs cannot flake on delayed timer delivery.
  await waitFor(() => tab.chatScrollOffset >= 2);
  assert.ok(tab.chatScrollOffset >= 2, `expected auto-scroll, got ${tab.chatScrollOffset}`);

  assert.equal(
    handleMouseInput(state, tab, "\x1b[<0;1;5m", tui, undefined, undefined, async (text) => {
      copied.push(text);
    }),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const stoppedOffset = tab.chatScrollOffset;
  await Bun.sleep(80);
  assert.equal(tab.chatScrollOffset, stoppedOffset);
  assert.deepEqual(copied, [allLines.slice(bottomStart - stoppedOffset).join("\n")]);
});

test("handleMouseInput keeps wheel scrolling separate from selection", () => {
  const { state, tab, tui } = setup();
  assert.equal(
    handleMouseInput(state, tab, "\x1b[<64;2;6M", tui, undefined, undefined, async () => undefined),
    true,
  );
  assert.equal(tab.chatSelection, undefined);
});

test("handleMouseInput scrolls chat wheel during extension user interaction overlays", () => {
  const { state, tab } = setup();
  tab.extensionUi.waitingForInputs.push({ id: "ask-user-question", kind: "custom" });
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => testOverlayHandle(),
    hasOverlay: () => true,
  };

  assert.equal(
    handleMouseInput(state, tab, "\x1b[<64;2;6M", tui, undefined, undefined, async () => undefined),
    true,
  );
  assert.equal(tab.chatScrollOffset, 3);
  assert.equal(renders, 1);
});

test("handleMixCodeKeyInput lets input selection run before extension terminal mouse handling", () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 30, height: 3 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────",
    " draft text                   ",
    "──────────────────────────────",
  ];
  const consumedByRuntime: string[] = [];
  const result = handleMixCodeKeyInput(
    state,
    "\x1b[<0;1;9M",
    tui,
    undefined,
    testRuntime({
      dispatchTerminalInput: (_sessionId, data) => {
        consumedByRuntime.push(data);
        return { consume: true };
      },
    }),
  );

  assert.deepEqual(result, { consume: true });
  assert.deepEqual(consumedByRuntime, []);
  assert.equal(tab.inputSelection?.dragging, true);
});

test("handleMouseInput drags and copies home input editor body", async () => {
  const { state, tab, tui } = setup();
  state.activeTabId = "home";
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 30, height: 3 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────",
    " home draft                   ",
    "──────────────────────────────",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;30;11M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;30;11m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["home draft"]);
  assert.equal(tab.inputSelection, undefined);
});

test("handleMouseInput drags and copies default input editor body", async () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 30, height: 4 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────",
    " hello world                  ",
    " second line                  ",
    "──────────────────────────────",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;30;12M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;30;12m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["hello world\nsecond line"]);
  assert.equal(tab.toast?.message, "Copied 23 chars.");
  assert.equal(tab.inputSelection, undefined);
});

test("handleMouseInput preserves meaningful input body formatting", async () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 34, height: 6 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────────",
    "     indented code                ",
    " ---                             ",
    " enter | accept are words        ",
    " scroll · marker is text         ",
    "──────────────────────────────────",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;34;14M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;34;14m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["    indented code\n---\nenter | accept are words\nscroll · marker is text"]);
});

test("handleMouseInput drags and copies btw-style editor visible body", async () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 34, height: 5 };
  tab.lastRenderedInputLines = [
    "┌─ BTW answer ─────────────────┐",
    "│ visible one                  │",
    "│ visible two                  │",
    "│ ↑↓ scroll · enter accept     │",
    "└──────────────────────────────┘",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;34;13M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;34;13m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["visible one\nvisible two"]);
  assert.equal(tab.toast?.message, "Copied 23 chars.");
  assert.equal(tab.inputSelection, undefined);
});

test("handleMouseInput drags and copies active Notice panel text", async () => {
  const { state, tab, tui } = setup();
  const copied: string[] = [];
  const noticeTui = {
    requestRender: tui.requestRender,
    showOverlay: (component: { render: (width: number) => string[] }, options: { width?: number }) => {
      component.render(typeof options.width === "number" ? options.width : 40);
      return testOverlayHandle();
    },
    hasOverlay: () => true,
  };
  showNoticeTextOverlay(noticeTui, "hello notice body");
  const notice = getActiveNotice();
  assert.ok(notice?.bounds, "notice bounds required for selection");

  // Force a known rectangle so SGR coordinates map cleanly in the unit test.
  notice.bounds = { top: 10, left: 1, width: 20, height: 3 };
  notice.renderedLines = ["hello notice body", "second line here", "c/y copy · Esc close"];

  assert.equal(
    handleMouseInput(state, tab, "\x1b[<0;7;10M", tui, undefined, undefined, async (text) => {
      copied.push(text);
    }),
    true,
  );
  assert.equal(
    handleMouseInput(state, tab, "\x1b[<32;7;11M", tui, undefined, undefined, async (text) => {
      copied.push(text);
    }),
    true,
  );
  assert.equal(
    handleMouseInput(state, tab, "\x1b[<0;7;11m", tui, undefined, undefined, async (text) => {
      copied.push(text);
    }),
    true,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["notice body\nsecond"]);
  assert.equal(tab.toast?.message, "Copied 18 chars.");
  assert.equal(getActiveNotice()?.selection, undefined);
  closeAppOverlay(noticeTui);
});

test("handleMixCodeKeyInput consumes c while Notice is open", async () => {
  const { state, tui } = setup();
  const noticeTui = {
    requestRender: tui.requestRender,
    showOverlay: (component: { render: (width: number) => string[] }, options: { width?: number }) => {
      component.render(typeof options.width === "number" ? options.width : 40);
      return testOverlayHandle();
    },
    hasOverlay: () => true,
  };
  showNoticeTextOverlay(noticeTui, "full notice payload");
  try {
    assert.deepEqual(handleMixCodeKeyInput(state, "c", tui), { consume: true });
    assert.deepEqual(handleMixCodeKeyInput(state, "y", tui), { consume: true });
  } finally {
    closeAppOverlay(noticeTui);
  }
});

test("tab clicks do not switch sessions through a modal command palette", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  state.tabBarTopRow = 1;
  state.lastRenderWidth = 120;
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return testOverlayHandle(() => {
        overlayOpen = false;
      });
    },
    hasOverlay: () => overlayOpen,
  };
  const secondTab = tabBarHitRegions(state, 120).find((region) => region.id === "s2");
  assert.ok(secondTab);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, true);
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      `\x1b[<0;${secondTab.startX};${state.tabBarTopRow + (secondTab.row ?? 0)}M`,
      tui,
    ),
    { consume: true },
  );

  assert.equal(state.activeTabId, "s1");
  assert.equal(state.commandPaletteOpen, true);
  closeAppOverlay(tui);
});

test("tab drag motion does not switch tabs", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  state.tabBarTopRow = 1;
  state.lastRenderWidth = 120;
  const tui = testTui({ requestRender: () => undefined });
  const secondTab = tabBarHitRegions(state, 120).find((region) => region.id === "s2");
  assert.ok(secondTab);
  const y = state.tabBarTopRow + (secondTab.row ?? 0);
  const x = secondTab.startX;

  // Motion events use button base 32 (SGR bit 5) and must not switch tabs.
  handleMouseInput(state, state.tabs[0], `\x1b[<32;${x};${y}M`, tui);
  assert.equal(state.activeTabId, "s1");

  // A real press still switches.
  assert.equal(
    handleMouseInput(state, state.tabs[0], `\x1b[<0;${x};${y}M`, tui),
    true,
  );
  assert.equal(state.activeTabId, "s2");
});

test("Command Palette wheel moves selection and click runs the row", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  openCommandPalette(state);
  assert.equal(state.commandPaletteOpen, true);
  assert.ok(planCommandPaletteList(state).entries.length >= 2);

  const ran: string[] = [];
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return testOverlayHandle(() => {
        overlayOpen = false;
      });
    },
    hasOverlay: () => overlayOpen,
  };
  showLinesOverlay(tui, () => ["Command Palette"]);
  const actions = {
    executeCommand: (command: string) => {
      ran.push(command);
    },
  };

  const start = state.commandPalette.selectedIndex;
  assert.equal(handleCommandPaletteMouse(state, "\x1b[<65;10;10M", tui, actions), true);
  assert.equal(state.commandPaletteOpen, true);
  assert.equal(state.commandPalette.selectedIndex, start + 1);
  assert.equal(handleCommandPaletteMouse(state, "\x1b[<64;10;10M", tui, actions), true);
  assert.equal(state.commandPalette.selectedIndex, start);

  const termWidth = process.stdout.columns || 80;
  const termHeight = process.stdout.rows || 24;
  const plan = planCommandPaletteList(state);
  const target = plan.entryBodyLines.find((hit) => hit.entryIndex === 1);
  assert.ok(target);
  const layout = resolveOverlayLayout(
    defaultOverlayOptions(),
    plan.bodyLineCount + 2,
    termWidth,
    termHeight,
  );
  const y = layout.row + 1 + target.bodyLine + 1;
  const x = layout.col + 2;
  assert.equal(
    hitTestListOverlay(
      planCommandPaletteList(state, []),
      { x, y },
      undefined,
      termWidth,
      termHeight,
    ),
    1,
  );

  const expected = plan.entries[1]!.command;
  assert.equal(handleCommandPaletteMouse(state, `\x1b[<0;${x};${y}M`, tui, actions), true);
  assert.equal(state.commandPaletteOpen, false);
  assert.deepEqual(ran, [expected]);
  assert.equal(overlayOpen, false);
});

test("Tab Jump wheel moves selection and click jumps to the row", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { alias: "alpha" }),
    createTab(2, "s2", "/repo", { alias: "beta" }),
    createTab(3, "s3", "/repo", { alias: "gamma" }),
  );
  state.activeTabId = "s1";
  openTabJump(state);
  assert.equal(state.tabJumpIndex, 1); // Home=0, s1=1

  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return testOverlayHandle(() => {
        overlayOpen = false;
      });
    },
    hasOverlay: () => overlayOpen,
  };
  // Seed the lines overlay so closeAppOverlay has a handle after jump.
  showLinesOverlay(tui, () => ["Tab Jump"]);
  assert.equal(overlayOpen, true);

  // Wheel down moves selection toward later tabs.
  assert.equal(handleTabJumpMouse(state, "\x1b[<65;10;10M", tui), true);
  assert.equal(state.tabJumpOpen, true);
  assert.equal(state.tabJumpIndex, 2);
  assert.equal(handleTabJumpMouse(state, "\x1b[<64;10;10M", tui), true);
  assert.equal(state.tabJumpIndex, 1);

  // Match handleTabJumpMouse defaults (process.stdout, with the same fallbacks).
  const termWidth = process.stdout.columns || 80;
  const termHeight = process.stdout.rows || 24;
  const plan = planTabJumpList(state);
  const layout = resolveOverlayLayout(
    defaultOverlayOptions(),
    plan.bodyLineCount + 2,
    termWidth,
    termHeight,
  );
  const target = plan.entryBodyLines.find((hit) => hit.entryIndex === 3); // s3
  assert.ok(target);
  // screen y is 1-based: layout.row (0-based) + top border + bodyLine + 1
  const y = layout.row + 1 + target.bodyLine + 1;
  const x = layout.col + 2;
  assert.equal(
    hitTestListOverlay(planTabJumpList(state), { x, y }, undefined, termWidth, termHeight),
    3,
  );

  assert.equal(handleTabJumpMouse(state, `\x1b[<0;${x};${y}M`, tui), true);
  assert.equal(state.tabJumpOpen, false);
  assert.equal(state.activeTabId, "s3");
  assert.equal(overlayOpen, false);
});

test("re-clicking the active tab opens Tab Jump", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.tabBarTopRow = 1;
  state.lastRenderWidth = 120;
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return testOverlayHandle(() => {
        overlayOpen = false;
      });
    },
    hasOverlay: () => overlayOpen,
  };
  const regions = tabBarHitRegions(state, 120);
  const home = regions.find((region) => region.id === "home");
  const agent = regions.find((region) => region.id === "s1");
  const other = regions.find((region) => region.id === "s2");
  assert.ok(home && agent && other);

  // Home re-click → Tab Jump.
  state.activeTabId = "home";
  assert.equal(
    handleMouseInput(
      state,
      state.tabs[0],
      `\x1b[<0;${home.startX};${state.tabBarTopRow + (home.row ?? 0)}M`,
      tui,
    ),
    true,
  );
  assert.equal(state.activeTabId, "home");
  assert.equal(state.tabJumpOpen, true);
  assert.equal(overlayOpen, true);
  closeAppOverlay(tui);
  state.tabJumpOpen = false;
  overlayOpen = false;

  // Agent re-click → Tab Jump, stay on that tab.
  state.activeTabId = "s1";
  assert.equal(
    handleMouseInput(
      state,
      state.tabs[0],
      `\x1b[<0;${agent.startX};${state.tabBarTopRow + (agent.row ?? 0)}M`,
      tui,
    ),
    true,
  );
  assert.equal(state.activeTabId, "s1");
  assert.equal(state.tabJumpOpen, true);
  assert.equal(overlayOpen, true);
  closeAppOverlay(tui);
  state.tabJumpOpen = false;
  overlayOpen = false;

  // Click a different tab → switch only, no Tab Jump.
  assert.equal(
    handleMouseInput(
      state,
      state.tabs[0],
      `\x1b[<0;${other.startX};${state.tabBarTopRow + (other.row ?? 0)}M`,
      tui,
    ),
    true,
  );
  assert.equal(state.activeTabId, "s2");
  assert.equal(state.tabJumpOpen, false);
  assert.equal(overlayOpen, false);
});

test("input meta drag motion does not open pickers", () => {
  const { state, tab } = setup();
  state.activeTabId = "s1";
  tab.inputMetaHitRegions = [{ action: "models", row: 20, startX: 5, endX: 20 }];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => testOverlayHandle(),
    hasOverlay: () => false,
  };

  handleMouseInput(state, tab, "\x1b[<32;10;20M", tui);
  // Read through locals: assert.equal is `asserts actual is T`, so asserting on
  // state.picker directly would pin it to undefined for the rest of the scope.
  const afterMotion = state.picker;
  assert.equal(afterMotion, undefined);

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;10;20M", tui), true);
  const afterClick = state.picker;
  assert.equal(afterClick?.kind, "models");
});

test("chat drag-select is blocked while a modal overlay is open", async () => {
  const { state, tab, tui } = setup();
  const overlayTui = {
    ...tui,
    showOverlay: () => testOverlayHandle(),
    hasOverlay: () => true,
  };
  // Open a modal-style overlay (picker path uses hasAnyOverlay).
  showLinesOverlay(overlayTui, () => ["Choose Thinking", "low", "high"]);
  assert.equal(hasAnyOverlay(overlayTui), true);

  // Live TUI routes mouse through handleMixCodeKeyInput; with an overlay open
  // chat drag-select must not run (no toast / no selection).
  handleMixCodeKeyInput(state, "\x1b[<0;7;5M", overlayTui, undefined, undefined);
  handleMixCodeKeyInput(state, "\x1b[<32;6;6M", overlayTui, undefined, undefined);
  handleMixCodeKeyInput(state, "\x1b[<0;6;6m", overlayTui, undefined, undefined);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tab.toast, undefined);
  assert.equal(tab.chatSelection, undefined);
});

test("handleMouseInput maps chat scrollbar gutter clicks to chatScrollOffset", () => {
  const { state, tab, tui } = setup();
  // content width 20 → scrollbar at col left+width = 21
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 20, height: 10 };
  tab.lastChatScrollMetrics = {
    total: 100,
    viewport: 10,
    start: 0,
    end: 10,
    scrollable: true,
  };
  tab.chatScrollOffset = 0;
  tab.chatScrollAnchorEntryId = "anchor";

  // Click top of track (y=5) → oldest → high offset
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;21;5M", tui), true);
  assert.equal(tab.chatScrollOffset, 90);
  assert.equal(tab.chatScrollAnchorEntryId, undefined);

  // Click bottom of track (y=14 = top+height-1) → newest → offset 0
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;21;14M", tui), true);
  assert.equal(tab.chatScrollOffset, 0);

  // Click mid (y=9.5 ~ row index 4.5 → 4) fraction 4/9 → offset round(5/9*90)=50
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;21;9M", tui), true);
  assert.equal(tab.chatScrollOffset, Math.round((1 - 4 / 9) * 90));

  // Outside gutter column is not handled by scrollbar path (selection may still eat it)
  tab.chatScrollOffset = 12;
  const handled = handleMouseInput(state, tab, "\x1b[<0;10;7M", tui);
  // content click may be selection; offset must not jump via scrollbar
  assert.equal(tab.chatScrollOffset, 12);
  void handled;
});

test("handleMouseInput ignores scrollbar click when chat is not scrollable", () => {
  const { state, tab, tui } = setup();
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 20, height: 10 };
  tab.lastChatScrollMetrics = {
    total: 8,
    viewport: 10,
    start: 0,
    end: 8,
    scrollable: false,
  };
  tab.chatScrollOffset = 0;
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;21;5M", tui), false);
  assert.equal(tab.chatScrollOffset, 0);
});
