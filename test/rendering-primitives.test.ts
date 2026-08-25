import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBackgroundLine } from "../src/ui/rendering/primitives.js";
import { joinColumns } from "../src/ui/rendering/layout.js";

const OUTER_BACKGROUND = {
  start: "\x1b[48;2;40;50;40m",
  end: "\x1b[49m",
};

test("renderBackgroundLine preserves an explicit nested background until reset", () => {
  const nestedStart = "\x1b[48;2;53;67;48m";
  const backgroundReset = "\x1b[49m";

  assert.equal(
    renderBackgroundLine(`${nestedStart}ROW${backgroundReset}`, 3, OUTER_BACKGROUND),
    `${OUTER_BACKGROUND.start}${nestedStart}ROW${backgroundReset}${OUTER_BACKGROUND.start}${OUTER_BACKGROUND.end}`,
  );
});

test("renderBackgroundLine preserves explicit ANSI background forms", () => {
  const backgrounds = ["\x1b[42m", "\x1b[102m", "\x1b[48;5;22m", "\x1b[48:2::53:67:48m"];

  for (const nestedStart of backgrounds) {
    assert.equal(
      renderBackgroundLine(`${nestedStart}ROW`, 3, OUTER_BACKGROUND),
      `${OUTER_BACKGROUND.start}${nestedStart}ROW${OUTER_BACKGROUND.end}`,
    );
  }
});

test("renderBackgroundLine restores the outer background after full or empty resets", () => {
  const foreground = "\x1b[38;2;49;120;200m";

  for (const fullReset of ["\x1b[0m", "\x1b[m"]) {
    assert.equal(
      renderBackgroundLine(`${foreground}A${fullReset}B`, 2, OUTER_BACKGROUND),
      `${OUTER_BACKGROUND.start}${foreground}A${fullReset}${OUTER_BACKGROUND.start}B${OUTER_BACKGROUND.end}`,
    );
  }
});

test("renderBackgroundLine follows the final background operation in a compound SGR", () => {
  const resetThenNested = "\x1b[0;48;2;53;67;48m";
  const nestedThenReset = "\x1b[48;5;22;49m";

  assert.equal(
    renderBackgroundLine(`${resetThenNested}A${nestedThenReset}B`, 2, OUTER_BACKGROUND),
    `${OUTER_BACKGROUND.start}${resetThenNested}A${nestedThenReset}${OUTER_BACKGROUND.start}B${OUTER_BACKGROUND.end}`,
  );
});

test("joinColumns resets SGR state before the right column", () => {
  // Column isolation contract: even when a left-column row ends with an
  // unbalanced SGR (e.g. a background color left open), the right column
  // must never inherit that state.
  const openGreenBg = "\x1b[42mleft";

  const [joined] = joinColumns([openGreenBg], ["task"], 10, 6);

  const rightStart = joined!.lastIndexOf("task");
  const betweenColumns = joined!.slice(openGreenBg.length, rightStart);
  assert.match(betweenColumns, /\x1b\[0m/);
});
