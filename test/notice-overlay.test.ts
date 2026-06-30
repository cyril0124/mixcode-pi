// Tests for the notice/error overlay panel rendering (src/ui/app-overlays.ts).
//
// showNoticeTextOverlay / showErrorOverlay render a bordered panel with a
// title bar, wrapped body text, and a dim "Esc to close" hint. The panel must:
//   - wrap long messages by panel width instead of truncating per line
//   - show a title ("Notice" for transient, "Error" for errors)
//   - include an "Esc to close" hint line
//   - keep every input word visible in the wrapped body

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderNoticePanel } from "../src/ui/app-overlays.js";
import { themeForId } from "../src/ui/themes.js";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = themeForId("mixcode-dark");

test("renderNoticePanel draws a bordered panel with title and Esc hint", () => {
  const lines = renderNoticePanel("Saved", 40, theme, { title: "Notice" }).map(stripAnsi);
  const joined = lines.join("\n");

  assert.match(lines[0] ?? "", /┌.*Notice.*┐/, "top border should carry the title");
  assert.match(lines.at(-1) ?? "", /└─+┘/, "bottom border should close the box");
  assert.match(joined, /Saved/, "message body should render");
  assert.match(joined, /Esc to close/, "Esc hint should render");
});

test("renderNoticePanel uses 'Error' title for the error variant", () => {
  const lines = renderNoticePanel("boom", 40, theme, { title: "Error", danger: true }).map(
    stripAnsi,
  );
  assert.match(lines[0] ?? "", /┌.*Error.*┐/, "top border should carry the Error title");
});

test("renderNoticePanel wraps long messages without dropping words", () => {
  const message =
    "Copy failed: clipboard provider returned a very long diagnostic path " +
    "/tmp/example/that/keeps/going/forever with extra trailing details";
  // Width 60 -> inner 56 cols: every token (longest is the 37-char path) fits,
  // so wrapping happens at word boundaries rather than hard-breaking a token.
  const lines = renderNoticePanel(message, 60, theme, { title: "Error", danger: true }).map(
    stripAnsi,
  );

  // Every whitespace-separated word from the input must survive somewhere in
  // the wrapped body (no per-line truncation / ellipsis dropping content).
  const body = lines.join("\n");
  for (const word of message.split(/\s+/)) {
    assert.ok(body.includes(word), `wrapped body should still contain "${word}"`);
  }
  // More than the single-line case: wrapping produced multiple body rows.
  const bodyRows = lines.filter((line) => line.startsWith("│"));
  assert.ok(bodyRows.length >= 3, "long message should wrap to multiple rows");
});

test("renderNoticePanel pads every line to the requested width", () => {
  const width = 48;
  const lines = renderNoticePanel("hi", width, theme, { title: "Notice" });
  for (const line of lines) {
    assert.equal(visibleWidth(stripAnsi(line)), width, "each line should fill the panel width");
  }
});
