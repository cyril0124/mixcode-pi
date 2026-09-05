import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateScrollbarGeometry,
  encodeITerm2,
  encodeKitty,
  getOsc8LinkAtColumn,
  paintScrollbarCell,
  type ScrollbarGeometry,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

const track = { column: 19, trackTop: 3, trackHeight: 10, contentHeight: 100 };

test("scrollbar geometry reaches both endpoints with a two-cell minimum thumb", () => {
  const top: ScrollbarGeometry = {
    column: 19,
    trackTop: 3,
    trackHeight: 10,
    thumbTop: 3,
    thumbHeight: 2,
    maxScrollTop: 90,
  };
  assert.deepEqual(calculateScrollbarGeometry({ ...track, scrollTop: 0 }), top);
  assert.deepEqual(calculateScrollbarGeometry({ ...track, scrollTop: 90 }), {
    ...top,
    thumbTop: 11,
  });
  assert.deepEqual(calculateScrollbarGeometry({ ...track, contentHeight: 30, scrollTop: 10 }), {
    ...top,
    thumbTop: 7,
    thumbHeight: 3,
    maxScrollTop: 20,
  });
});

test("scrollbar geometry handles empty content and short tracks without invalid dimensions", () => {
  for (const contentHeight of [0, 1, 10]) {
    assert.deepEqual(calculateScrollbarGeometry({ ...track, contentHeight, scrollTop: 0 }), {
      column: 19,
      trackTop: 3,
      trackHeight: 10,
      thumbTop: 3,
      thumbHeight: 10,
      maxScrollTop: 0,
    });
  }
  assert.deepEqual(calculateScrollbarGeometry({ ...track, trackHeight: 1, scrollTop: 99 }), {
    column: 19,
    trackTop: 3,
    trackHeight: 1,
    thumbTop: 3,
    thumbHeight: 1,
    maxScrollTop: 99,
  });
  for (const trackHeight of [0, -1]) {
    assert.equal(calculateScrollbarGeometry({ ...track, trackHeight, scrollTop: 0 }), undefined);
  }
});

test("scrollbar painting blanks the other half of a wide grapheme and keeps neighboring cells", () => {
  const line = "A\u4e2dB";
  for (const [column, expected] of [
    [1, "A# B"],
    [2, "A #B"],
  ] as const) {
    const painted = paintScrollbarCell(line, column, 4, "#", true);
    assert.equal(stripTerminalSequences(painted), expected);
    assert.equal(visibleWidth(painted), 4);
  }
  const padded = paintScrollbarCell("A", 3, 4, "#", false);
  assert.equal(stripTerminalSequences(padded), "A  #");
  assert.equal(visibleWidth(padded), 4);
});

test("scrollbar painting resets foreground and preserves the target background only when requested", () => {
  const line = "\x1b[31m\x1b[44mABC\x1b[0m";
  for (const preserve of [true, false]) {
    const painted = paintScrollbarCell(line, 1, 3, "#", preserve);
    const reset = `\x1b[0m\x1b]8;;\x07${preserve ? "\x1b[44m" : ""}#`;
    assert.ok(
      painted.includes(reset),
      "replacement resets foreground and applies the requested background",
    );
    assert.equal(stripTerminalSequences(painted), "A#C");
    assert.equal(visibleWidth(painted), 3);
    assert.ok(painted.indexOf("\x1b[31m", painted.indexOf("#")) > painted.indexOf("#"));
  }
});

test("scrollbar painting closes OSC 8 at the replaced cell and preserves neighboring links", () => {
  const url = "https://example.com/scrollbar";
  for (const terminator of ["\x07", "\x1b\\"]) {
    const line = `\x1b]8;;${url}${terminator}ABC\x1b]8;;${terminator}`;
    const painted = paintScrollbarCell(line, 1, 3, "#", true);
    assert.equal(stripTerminalSequences(painted), "A#C");
    assert.equal(getOsc8LinkAtColumn(painted, 0), url);
    assert.equal(getOsc8LinkAtColumn(painted, 1), undefined);
    assert.equal(getOsc8LinkAtColumn(painted, 2), url);
  }
});

test("scrollbar painting leaves Kitty and iTerm2 image protocol lines byte-for-byte intact", () => {
  const payload = "iVBORw0KGgo=";
  for (const image of [encodeKitty(payload), encodeITerm2(payload)]) {
    for (const line of [image, `\x1b[2A${image}`]) {
      assert.equal(paintScrollbarCell(line, 1, 10, "#", true), line);
      assert.equal(paintScrollbarCell(line, 1, 10, "#", false), line);
    }
  }
});
