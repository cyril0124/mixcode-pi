import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createInitialState, createTab, scrollChat } from "./helpers/mixcode.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";
import { testTui } from "./helpers/tui.js";
import { handleMouseInput, stopChatSelectionAutoScroll } from "../src/ui/app-mouse.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

const WIDTH = 80;
const HEIGHT = 15;

function setup(blockCount = 1, lineCount = 100) {
  const state = createInitialState("/repo");
  const tab = createTab(1, `selection-scroll-${blockCount}-${lineCount}`, "/repo", {
    status: "running",
  });
  state.tabs = [tab];
  state.activeTabId = tab.sessionId;
  tab.chatSurfaceBounds = { top: 3, left: 1, width: WIDTH - 1, height: HEIGHT };
  const tail = {
    role: "assistant" as const,
    text: Array.from({ length: lineCount }, (_, index) => `ROW-${index}`).join("\n"),
  };
  const runtimeTab = testRuntimeTab({
    tab,
    chat: [
      ...Array.from({ length: blockCount - 1 }, (_, index) => ({
        role: "user" as const,
        text: `history-${index}`,
      })),
      tail,
    ],
    streamingAssistant: {
      chatIndex: blockCount - 1,
      blockIndices: new Map([[0, blockCount - 1]]),
      toolCallIndices: new Map(),
    },
  });
  const copied: string[] = [];
  const render = () => renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT);
  // Keep rendering explicit so input can arrive before a scheduled paint.
  const tui = testTui();
  const mouse = (button: number, row: number, col = 0, release = false) => {
    const bounds = tab.chatSurfaceBounds!;
    assert.equal(
      handleMouseInput(
        state,
        tab,
        `\x1b[<${button};${bounds.left + col};${bounds.top + row}${release ? "m" : "M"}`,
        tui,
        undefined,
        undefined,
        async (text) => {
          copied.push(text);
        },
      ),
      true,
    );
  };
  return { tab, tail, runtimeTab, tui, render, mouse, copied };
}

function copiedRowNumbers(copied: string[]): number[] {
  assert.equal(copied.length, 1);
  return [...copied[0]!.matchAll(/ROW-(\d+)/g)].map((match) => Number(match[1]));
}

for (const blockCount of [1, 65]) {
  for (const paintDrag of [true, false]) {
    test(`dragging from the live tail keeps selected rows fixed with ${blockCount} blocks and ${paintDrag ? "painted" : "pending"} drag`, () => {
      const { tab, tail, render, mouse, copied } = setup(blockCount);
      render();
      mouse(0, 10, 30);
      mouse(32, 2);
      if (paintDrag) render();
      const bodyBefore = tab.lastRenderedChatLines?.map(stripTerminalSequences);

      tail.text += "\n" + Array.from({ length: 10 }, (_, index) => `ADDED-${index}`).join("\n");
      render();

      assert.deepEqual(
        tab.lastRenderedChatLines?.map(stripTerminalSequences),
        bodyBefore,
        "stream growth moved selected rows",
      );
      mouse(0, 2, 0, true);
      assert.deepEqual(copiedRowNumbers(copied), [87, 88, 89, 90, 91, 92, 93, 94, 95]);
    });
  }

  for (const scrollOffset of [0, 10]) {
    test(`selecting a long streaming message preserves rows without new output with ${blockCount} blocks at offset ${scrollOffset}`, () => {
      const { tab, tail, render, mouse } = setup(blockCount);
      tail.text = Array.from(
        { length: 400 },
        (_, index) => `ROW-${String(index).padStart(3, "0")} 中文 ${"content ".repeat(8)}`,
      ).join("\n");
      render();
      scrollChat(tab, scrollOffset);
      render();
      const before = tab.lastRenderedChatLines!.map(stripTerminalSequences);
      mouse(0, 10, 30);
      mouse(32, 2);
      render();
      render();
      assert.deepEqual(tab.lastRenderedChatLines!.map(stripTerminalSequences), before);
    });
  }

  test(`a new large message cannot displace the selected viewport with ${blockCount} blocks`, () => {
    const { tab, runtimeTab, render, mouse, copied } = setup(blockCount);
    render();
    mouse(0, 10, 30);
    mouse(32, 2);
    const bodyBefore = tab.lastRenderedChatLines!.map(stripTerminalSequences);

    runtimeTab.chat.push({
      role: "assistant",
      text: Array.from({ length: 200 }, (_, index) => `ADDED-${index}`).join("\n"),
    });
    runtimeTab.streamingAssistant!.chatIndex = runtimeTab.chat.length - 1;
    render();

    assert.deepEqual(tab.lastRenderedChatLines!.map(stripTerminalSequences), bodyBefore);
    mouse(0, 2, 0, true);
    assert.deepEqual(copiedRowNumbers(copied), [87, 88, 89, 90, 91, 92, 93, 94, 95]);
  });

  test(`stream growth keeps dragged text and highlighting fixed with ${blockCount} blocks`, () => {
    const { tab, tail, render, mouse, copied } = setup(blockCount);
    render();
    scrollChat(tab, 10);
    render();
    mouse(0, 10, 30);
    mouse(32, 2);
    const before = render().map((line) => sliceByColumn(line, 0, WIDTH - 1));
    const bodyBefore = tab.lastRenderedChatLines;

    // Exercise growth while the chat block retains its object identity.
    tail.text += "\n" + Array.from({ length: 10 }, (_, index) => `ADDED-${index}`).join("\n");
    const after = render().map((line) => sliceByColumn(line, 0, WIDTH - 1));

    assert.deepEqual(tab.lastRenderedChatLines, bodyBefore, "stream growth moved visible text");
    assert.deepEqual(after, before, "stream growth moved the selection highlight");
    mouse(0, 2, 0, true);
    assert.deepEqual(copiedRowNumbers(copied), [77, 78, 79, 80, 81, 82, 83, 84, 85]);
  });

  for (const wheelBeforeDrag of [false, true]) {
    test(`scroll and growth from a selected live tail preserve row order with ${blockCount} blocks, wheel ${wheelBeforeDrag ? "before" : "after"} drag`, () => {
      const { tail, render, mouse, copied } = setup(blockCount);
      render();
      if (wheelBeforeDrag) mouse(64, 5);
      mouse(0, 10, 30);
      mouse(32, 2);
      if (!wheelBeforeDrag) {
        render();
        mouse(64, 5);
      }
      tail.text += "\nADDED-0\nADDED-1\nADDED-2";
      render();
      mouse(0, 2, 0, true);

      assert.deepEqual(copiedRowNumbers(copied), [84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95]);
    });
  }

  test(`scroll and stream growth in one frame preserve selected row order with ${blockCount} blocks`, () => {
    const { tab, tail, render, mouse, copied } = setup(blockCount);
    render();
    scrollChat(tab, 10);
    render();
    mouse(0, 10, 30);
    mouse(32, 2);
    render();

    mouse(64, 5);
    tail.text += "\nADDED-0\nADDED-1\nADDED-2";
    render();
    mouse(0, 2, 0, true);

    assert.deepEqual(copiedRowNumbers(copied), [74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85]);
  });
}

for (const growth of [2, 20]) {
  test(`selecting a short transcript preserves existing rows when ${growth} rows arrive`, () => {
    const { tab, tail, render, mouse, copied } = setup(1, 3);
    render();
    const before = tab.lastRenderedChatLines!.map(stripTerminalSequences);
    const start = before.findIndex((line) => line.includes("ROW-0"));
    const end = before.findIndex((line) => line.includes("ROW-1"));
    assert.ok(start >= 0 && end > start);
    mouse(0, end, 30);
    mouse(32, start);
    render();

    tail.text += "\n" + Array.from({ length: growth }, (_, index) => `ADDED-${index}`).join("\n");
    render();
    assert.deepEqual(
      tab.lastRenderedChatLines!.slice(start, end + 1).map(stripTerminalSequences),
      before.slice(start, end + 1),
    );
    mouse(0, start, 0, true);
    assert.deepEqual(copiedRowNumbers(copied), [0, 1]);

    if (growth === 2) {
      tail.text += "\n" + Array.from({ length: 20 }, (_, index) => `LATEST-${index}`).join("\n");
      render();
      assert.equal(tab.chatScrollOffset, 0, "releasing a selection at the tail resumes following");
      assert.match(tab.lastRenderedChatLines!.at(-1)!, /LATEST-19/);
    }
  });
}

test("drag input before a pending scroll paint copies the text still on screen", () => {
  const { render, mouse, copied, tab } = setup();
  render();
  scrollChat(tab, 10);
  render();
  mouse(0, 10, 30);
  render();

  // A wheel event changes the requested offset; the terminal still shows the old frame.
  mouse(64, 5);
  mouse(32, 2);
  mouse(0, 2, 0, true);

  assert.deepEqual(copiedRowNumbers(copied), [77, 78, 79, 80, 81, 82, 83, 84, 85]);
});

test("top-edge auto-scroll selects the first content row when its marker disappears", async () => {
  const { tab, tui, render, mouse, copied } = setup(1, 20);
  tui.requestRender = () => {
    render();
  };
  render();
  mouse(0, 10, 30);
  mouse(32, 0);
  try {
    const deadline = Date.now() + 3_000;
    while (tab.lastChatScrollMetrics!.start > 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    assert.equal(tab.lastChatScrollMetrics!.start, 0, "auto-scroll did not reach the top");
    mouse(0, 0, 0, true);
    assert.deepEqual(
      copiedRowNumbers(copied),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
  } finally {
    stopChatSelectionAutoScroll();
  }
});
