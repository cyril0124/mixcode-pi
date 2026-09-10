import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { highlightChatSelectionLine } from "../src/core/chat-selection.js";
import { MIXCODE_DARK_THEME } from "../src/ui/themes.js";

function recordingTerminal(writes: string[]): Terminal {
  return {
    columns: 120,
    rows: 10,
    kittyProtocolActive: false,
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: (data) => {
      writes.push(data);
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

for (const [terminatorName, terminator] of [
  ["BEL", "\x07"],
  ["ST", "\x1b\\"],
] as const) {
  for (const startColumn of [0, 5]) {
    test(`fullscreen selection excludes ${terminatorName} prompt zones from terminal output at column ${startColumn}`, () => {
      const writes: string[] = [];
      const tui = new TuiAltScreen(recordingTerminal(writes), false, undefined, {
        mouse: false,
        viewportInput: false,
      });
      const text = '没有"MakeInvalid 前必须先发 Evict"这种要求。';
      const line = `\x1b]133;A${terminator}${MIXCODE_DARK_THEME.bold(text)}\x1b]133;B${terminator}\x1b]133;C${terminator}`;
      let selecting = false;
      tui.addChild({
        render: () => [
          highlightChatSelectionLine(
            line,
            0,
            selecting
              ? {
                  anchor: { row: 0, col: startColumn },
                  focus: { row: 0, col: 13 },
                  dragging: true,
                }
              : undefined,
            MIXCODE_DARK_THEME.selectedBg,
          ),
        ],
        invalidate: () => undefined,
      });
      try {
        tui.start();
        tui.renderNow();
        writes.length = 0;
        selecting = true;
        tui.renderNow();
        const output = writes.join("");
        assert.equal(Bun.stripANSI(output), text);
        assert.doesNotMatch(
          output,
          /\x1b\]133;/,
          "prompt zones can move terminal cells during selection repaint",
        );

        // The renderer also prints the final document when returning to the main screen.
        writes.length = 0;
        tui.stop();
        assert.doesNotMatch(writes.join(""), /\x1b\]133;/);
      } finally {
        tui.stop({ preserveScreen: true });
      }
    });
  }
}
