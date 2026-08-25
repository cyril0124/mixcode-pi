import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTab, pushToast, renderAgentSurface } from "./helpers/mixcode.js";
import { applyToastOverlay } from "../src/ui/components/toast-overlay.js";
import { themeForId } from "../src/ui/themes.js";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("pushToast stores explicit toast type with message", () => {
  const tab = createTab(1, "s1", "/repo");

  pushToast(tab, { type: "success", message: "Copied 11 chars." });

  assert.equal(tab.toast?.type, "success");
  assert.equal(tab.toast?.message, "Copied 11 chars.");
});

test("renderAgentSurface overlays a typed toast card with right margin", () => {
  const tab = createTab(1, "s1", "/repo");
  pushToast(tab, { type: "success", message: "Copied 11 chars." });

  const lines = renderAgentSurface(
    tab,
    { chat: [{ role: "assistant", text: "hello" }] } as never,
    60,
    8,
  ).map(stripAnsi);
  const toastTop = lines.find((line) => line.includes("╭") && line.includes("╮"));
  const toastMid = lines.find((line) => line.includes("✓ Copied 11 chars."));
  const toastBottom = lines.find((line) => line.includes("╰") && line.includes("╯"));

  assert.ok(toastTop, "toast top border should render");
  assert.ok(toastMid, "toast message should render");
  assert.ok(toastBottom, "toast bottom border should render");
  assert.equal(toastTop.endsWith(" "), true, "toast should leave a right margin");
  assert.equal(visibleWidth(toastTop), 60);
  assert.match(toastMid, /│ ✓ Copied 11 chars\.\s+│\s+$/);
});

test("renderAgentSurface wraps long toast messages to at most three rows", () => {
  const tab = createTab(1, "s1", "/repo");
  pushToast(tab, {
    type: "error",
    message:
      "Copy failed: clipboard provider returned a very long diagnostic path /tmp/example/that/keeps/going/forever with extra details",
  });

  const lines = renderAgentSurface(
    tab,
    { chat: [{ role: "assistant", text: "hello" }] } as never,
    80,
    10,
  ).map(stripAnsi);
  const toastRows = lines.filter((line) => /[╭╰]─|│ .*│/.test(line));

  assert.equal(toastRows.length, 5);
  assert.equal(toastRows.filter((line) => line.includes("│")).length, 3);
  assert.match(toastRows.at(-2) ?? "", /…\s+│\s+$/);
});

test("renderAgentSurface skips toast card when viewport is too small", () => {
  const tab = createTab(1, "s1", "/repo");
  pushToast(tab, { type: "info", message: "Too narrow" });

  const output = renderAgentSurface(
    tab,
    { chat: [{ role: "assistant", text: "hello" }] } as never,
    20,
    4,
  )
    .map(stripAnsi)
    .join("\n");

  assert.doesNotMatch(output, /Too narrow/);
});

test("applyToastOverlay closes SGR state at the end of every composited row", () => {
  // compositeTuiLine can drop the base line's trailing bg reset; an open
  // background would then leak into whatever is appended after the row
  // (chat scrollbar cell, sidebar column).
  const width = 60;
  const bgRow = `\x1b[48;2;40;50;40m${"x".repeat(width)}\x1b[49m`;
  const lines = Array.from({ length: 8 }, () => bgRow);

  const result = applyToastOverlay(
    lines,
    { type: "info", message: "Copied to clipboard.", createdAt: Date.now() },
    width,
    8,
    themeForId("mixcode-dark"),
  );

  for (const [row, line] of result.entries()) {
    if (line === bgRow) continue; // untouched rows keep their own reset
    assert.equal(line.endsWith("\x1b[0m"), true, `row ${row} leaves SGR state open`);
  }
});
