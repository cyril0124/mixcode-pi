import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCapabilities,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ChatLine, RuntimeTab } from "../src/agent/runtime.js";
import { chatEnd, scrollChat } from "../src/core/overlays.js";
import { createInitialState, createTab } from "./helpers/mixcode.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { handleMouseInput } from "../src/ui/app-mouse.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { testTui } from "./helpers/tui.js";

function setup(count = 12) {
  const state = createInitialState("/repo");
  const tab = createTab(1, `jump-${count}`, "/repo");
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const chat: ChatLine[] = Array.from({ length: count }, (_, i) => ({
    role: "user",
    entryId: `entry-${i}`,
    text: `message-${i}\nsecond line ${i}`,
  }));
  const runtimeTab = { chat } as RuntimeTab;
  let lines: string[] = [];
  const render = (width = 80, height = 12) => {
    tab.chatSurfaceBounds = { top: 5, left: 1, width: width - 1, height };
    lines = renderAgentSurface(tab, runtimeTab, width, height);
    return lines.map(stripTerminalSequences);
  };
  const tui = testTui({
    requestRender: () => {
      render();
    },
  });
  const click = (button = 0, release = false) => {
    const row = lines.findIndex((line) => stripTerminalSequences(line).includes("Jump to latest"));
    assert.ok(row >= 0, "rendered jump target must exist");
    const col = stripTerminalSequences(lines[row]!).indexOf("Jump to latest");
    return `\x1b[<${button};${col + 1};${row + 5}${release ? "m" : "M"}`;
  };
  return { state, tab, chat, render, click, tui };
}

for (const count of [12, 100]) {
  test(`jump restores tail following for ${count}-message conversation via real input dispatch`, () => {
    const { state, tab, chat, render, click, tui } = setup(count);
    assert.doesNotMatch(render().join("\n"), /Jump to latest/);
    scrollChat(tab, 10);
    const before = render();
    assert.match(before.at(-1)!, /Jump to latest/);
    assert.doesNotMatch(before.at(-1)!, /· End/);
    assert.doesNotMatch(before.join("\n"), /newer below/);
    assert.equal(before.length, 12);
    assert.ok(before.every((line) => visibleWidth(line) <= 80));
    assert.doesNotMatch(tab.lastRenderedChatLines!.join("\n"), /Jump to latest/);

    handleMixCodeKeyInput(state, click(), tui, testRuntime({}));
    const after = render();
    assert.match(after.join("\n"), new RegExp(`message-${count - 1}`));
    assert.doesNotMatch(after.join("\n"), /Jump to latest/);
    assert.equal(tab.chatSelection, undefined, "click must not start a text selection");
    chat.push({ role: "assistant", text: "fresh-tail-after-jump" });
    assert.match(render().join("\n"), /fresh-tail-after-jump/);
  });
}

for (const mode of ["full", "windowed", "anchored"] as const) {
  for (const height of [1, 12]) {
    test(`floating jump preserves both sides of the original bottom row: ${mode}, height ${height}`, () => {
      const tab = createTab(1, `floating-${mode}-${height}`, "/repo");
      const chat: ChatLine[] = Array.from({ length: mode === "full" ? 12 : 100 }, (_, index) => ({
        role: "tool",
        entryId: `dense-${index}`,
        title: "dense",
        status: "success",
        text: "",
        toolRenderShell: "self",
        renderToolCall: (width) =>
          Array.from({ length: 30 }, (_, row) => {
            const left = `LEFT-${index}-${row} `;
            const right = ` RIGHT-${index}-${row}`;
            return left + "x".repeat(Math.max(0, width - left.length - right.length)) + right;
          }),
      }));
      if (mode === "anchored") {
        tab.chatScrollAnchorEntryId = "dense-10";
        tab.chatScrollAnchorIndex = 10;
      } else {
        tab.chatScrollOffset = 3;
      }
      const lines = renderAgentSurface(tab, { chat } as RuntimeTab, 80, height);
      const bottom = stripTerminalSequences(lines.at(-1)!);
      assert.match(bottom, /^LEFT-\d+-\d+ .*Jump to latest.* RIGHT-\d+-\d+[│┃█]$/);
      assert.equal(lines.length, height);
      const original = stripTerminalSequences(tab.lastRenderedChatLines!.at(-1)!);
      assert.match(original, /^LEFT-\d+-\d+ x+ RIGHT-\d+-\d+$/);
      const region = tab.chatJumpToLatestHitRegion!;
      assert.equal(bottom.slice(0, region.column), original.slice(0, region.column));
      assert.equal(
        bottom.slice(region.column + region.width, -1),
        original.slice(region.column + region.width),
      );
    });
  }
}

test("anchored viewport at offset zero offers jump and releases the message anchor", () => {
  const { state, tab, render, click, tui } = setup(100);
  tab.chatScrollAnchorEntryId = "entry-10";
  tab.chatScrollAnchorIndex = 10;
  const before = render();
  assert.equal(tab.chatScrollOffset, 0);
  assert.match(before.join("\n"), /message-10/);
  assert.match(before.at(-1)!, /Jump to latest/);
  handleMouseInput(state, tab, click(), tui);
  assert.match(render().join("\n"), /message-99/);
  assert.equal(tab.chatScrollAnchorEntryId, undefined);
});

test("only a primary press activates jump; motion, release and secondary press do not", () => {
  const { state, tab, render, click, tui } = setup();
  scrollChat(tab, 10);
  render();
  for (const [button, release] of [
    [32, false],
    [0, true],
    [2, false],
  ] as const) {
    const offset = tab.chatScrollOffset;
    handleMouseInput(state, tab, click(button, release), tui);
    assert.equal(tab.chatScrollOffset, offset);
  }
  handleMouseInput(state, tab, click(), tui);
  assert.doesNotMatch(render().join("\n"), /Jump to latest/);
});

test("a modal overlay prevents jump from reaching the underlying chat", () => {
  const { state, tab, render, click } = setup();
  scrollChat(tab, 10);
  render();
  const offset = tab.chatScrollOffset;
  const tui = testTui({ hasOverlay: () => true });
  handleMixCodeKeyInput(state, click(), tui, testRuntime({}));
  assert.equal(tab.chatScrollOffset, offset);
});

test("narrow chat and Vim label preserve width and do not resize the viewport", () => {
  const { tab, render } = setup();
  scrollChat(tab, 10);
  tab.vimMode = true;
  const wide = render(80);
  assert.match(wide.at(-1)!, /Jump to latest.*G/);
  const narrow = render(20);
  assert.equal(narrow.length, 12);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
  chatEnd(tab);
  assert.doesNotMatch(render(80).join("\n"), /Jump to latest/);
});

test("clearing or hiding the viewport removes the previous click target", () => {
  const { state, tab, chat, render, click, tui } = setup();
  scrollChat(tab, 10);
  render();
  const previousClick = click();
  renderAgentSurface(tab, { chat } as RuntimeTab, 80, 0);
  const offset = tab.chatScrollOffset;
  handleMouseInput(state, tab, previousClick, tui);
  assert.equal(tab.chatScrollOffset, offset);
});

test("showing jump in a long chat does not materialize offscreen tool renderers", () => {
  const { tab, chat, render } = setup(5000);
  let historicalRenders = 0;
  chat[0] = {
    role: "tool",
    title: "historical",
    status: "success",
    text: "",
    renderToolCall: () => {
      historicalRenders++;
      return ["historical output"];
    },
  };
  tab.status = "running";
  scrollChat(tab, 10);
  assert.match(render().at(-1)!, /Jump to latest/);
  assert.equal(historicalRenders, 0);
});

test("a single image row remains intact and has no invisible jump target", () => {
  const { tab } = setup();
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, images: "kitty" });
  try {
    const chat: ChatLine[] = [
      {
        role: "user",
        entryId: "image-entry",
        text: "",
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        ],
      },
    ];
    tab.chatScrollAnchorEntryId = "image-entry";
    tab.chatScrollAnchorIndex = 0;
    tab.chatScrollOffset = -2;
    const lines = renderAgentSurface(tab, { chat } as RuntimeTab, 80, 1);
    assert.ok(lines[0]!.includes("\x1b_G"), `image sequence missing from ${JSON.stringify(lines)}`);
    assert.equal(tab.chatJumpToLatestHitRegion, undefined);
  } finally {
    setCapabilities(capabilities);
  }
});

test("jump does not steal an active drag crossing the bottom label", async () => {
  const { state, tab, render, click, tui } = setup();
  scrollChat(tab, 10);
  render();
  const copied: string[] = [];
  handleMouseInput(state, tab, "\x1b[<0;2;7M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  });
  const offset = tab.chatScrollOffset;
  handleMouseInput(state, tab, click(32), tui, undefined, undefined, async (text) => {
    copied.push(text);
  });
  handleMouseInput(state, tab, click(0, true), tui, undefined, undefined, async (text) => {
    copied.push(text);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.chatScrollOffset, offset);
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0]!, /Jump to latest/);
});
