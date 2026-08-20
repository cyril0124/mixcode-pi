// Tests for the notice/error overlay panel rendering (src/ui/app-overlays.ts).
//
// showNoticeTextOverlay / showErrorOverlay render a bordered panel with a
// title bar, wrapped body text, and a dim copy/Esc hint. The panel must:
//   - wrap long messages by panel width instead of truncating per line
//   - show a title ("Notice" for transient, "Error" for errors)
//   - include a copy/close hint line
//   - keep every input word visible in the wrapped body

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOverlayLayout, visibleWidth } from "@earendil-works/pi-tui";
import {
  closeAppOverlay,
  copyActiveNoticeText,
  getActiveNotice,
  hasActiveNotice,
  hasAppOverlay,
  hasCapturingAppOverlay,
  showLinesOverlay,
  showNoticeTextOverlay,
} from "../src/ui/app-overlays.js";
import { renderNoticePanel } from "../src/ui/components/notice-panel.js";
import { themeForId } from "../src/ui/themes.js";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = themeForId("mixcode-dark");

test("renderNoticePanel draws a bordered panel with title and copy/Esc hint", () => {
  const lines = renderNoticePanel("Saved", 40, theme, { title: "Notice" }).map(stripAnsi);
  const joined = lines.join("\n");

  assert.match(lines[0] ?? "", /┌.*Notice.*┐/, "top border should carry the title");
  assert.match(lines.at(-1) ?? "", /└─+┘/, "bottom border should close the box");
  assert.match(joined, /Saved/, "message body should render");
  assert.match(joined, /c\/y copy/, "copy hint should render");
  assert.match(joined, /Esc close/, "Esc hint should render");
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

test("showNoticeTextOverlay tracks active notice and clears on close", () => {
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render: (width: number) => string[] }, options: { width?: number }) => {
      component.render(typeof options.width === "number" ? options.width : 40);
      return { hide: () => undefined };
    },
    hasOverlay: () => true,
  };
  showNoticeTextOverlay(tui, "hello notice body");
  assert.equal(hasActiveNotice(), true);
  assert.equal(getActiveNotice()?.text, "hello notice body");
  assert.ok(getActiveNotice()?.bounds, "bounds should be set after first render");
  assert.ok((getActiveNotice()?.renderedLines.length ?? 0) > 0);
  closeAppOverlay(tui);
  assert.equal(hasActiveNotice(), false);
});

test("notices are app overlays but do not count as capturing wait-for-input", () => {
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
    hasOverlay: () => true,
  };
  showNoticeTextOverlay(tui, "console leftover");
  assert.equal(hasAppOverlay(tui), true);
  assert.equal(hasCapturingAppOverlay(tui), false);
  closeAppOverlay(tui);
  showLinesOverlay(tui, () => ["[Y] Close    [N] Cancel"]);
  assert.equal(hasAppOverlay(tui), true);
  assert.equal(hasCapturingAppOverlay(tui), true);
  closeAppOverlay(tui);
});

test("copyActiveNoticeText copies full body via injected writer", async () => {
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render: (width: number) => string[] }, options: { width?: number }) => {
      component.render(typeof options.width === "number" ? options.width : 40);
      return { hide: () => undefined };
    },
    hasOverlay: () => true,
  };
  showNoticeTextOverlay(tui, "full notice payload");
  const copied: string[] = [];
  const result = await copyActiveNoticeText(async (text) => {
    copied.push(text);
  });
  assert.deepEqual(result, { chars: "full notice payload".length });
  assert.deepEqual(copied, ["full notice payload"]);
  closeAppOverlay(tui);
});

test("resolveOverlayLayout places bottom-center notice within terminal", () => {
  const layout = resolveOverlayLayout(
    { anchor: "bottom-center", width: 40, maxHeight: 12, margin: 1, offsetY: -4 },
    8,
    100,
    40,
  );
  assert.equal(layout.width, 40);
  assert.ok(layout.row >= 1, "row respects top margin");
  assert.ok(layout.col >= 1, "col respects left margin");
  assert.ok(layout.row + 8 <= 39, "panel stays above bottom margin after offset clamp");
});

test("closeAppOverlay only hides tracked app handles, never hideOverlay stack top", () => {
  // Regression: Ctrl+T used to call closeAppOverlay with an empty track map, which
  // fell through to tui.hideOverlay() and popped the extension overlay. The
  // extension never got its close() path, so pending interactions stayed forever
  // and Esc looked frozen. Contract: untracked overlays stay on the stack.
  type StackEntry = { name: string };
  const stack: StackEntry[] = [];
  let hideOverlayCalls = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: (_component: unknown) => {
      const entry: StackEntry = { name: stack.length === 0 ? "extension" : "app" };
      stack.push(entry);
      return {
        hide: () => {
          const index = stack.indexOf(entry);
          if (index !== -1) stack.splice(index, 1);
        },
      };
    },
    hasOverlay: () => stack.length > 0,
    hideOverlay: () => {
      hideOverlayCalls++;
      stack.pop();
    },
  };

  // Extension overlay is shown outside app overlay tracking.
  tui.showOverlay({ render: () => ["ext"] });
  assert.equal(stack.map((e) => e.name).join(","), "extension");

  closeAppOverlay(tui);
  assert.equal(hideOverlayCalls, 0, "must not call hideOverlay when nothing is tracked");
  assert.equal(stack.map((e) => e.name).join(","), "extension");

  // App path registers a handle; closing must only remove that entry.
  showLinesOverlay(tui, () => ["tab jump"]);
  assert.equal(stack.map((e) => e.name).join(","), "extension,app");

  closeAppOverlay(tui);
  assert.equal(hideOverlayCalls, 0);
  assert.equal(stack.map((e) => e.name).join(","), "extension");
});
