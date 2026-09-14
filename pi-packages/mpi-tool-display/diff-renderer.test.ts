import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import { stripAllEscapes } from "./render-utils.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "./types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

for (const width of [200, 80, 16]) {
  test(`collapsed diff keeps changes after wrapped context at width ${width}`, () => {
    // Four source lines fill more than 24 terminal rows, as in the reported Markdown diff.
    const context = "未修改的上下文包含较长路径 src/device/checker.scala ".repeat(18);
    const diff = [
      " ...",
      ...Array.from({ length: 4 }, (_, index) => ` ${40 + index}|${context}`),
      "-44|OLD",
      "+44|NEW",
      "+45|TAIL",
    ].join("\n");
    const component = renderEditDiffResult(
      { diff },
      { expanded: false, filePath: "notes.md" },
      DEFAULT_TOOL_DISPLAY_CONFIG,
      theme,
      "",
    );
    const lines = component.render(width).map(stripAllEscapes);
    const text = lines.join("\n");
    assert.match(text, /OLD/);
    assert.match(text, /NEW/);
    assert.match(text, /TAIL/);
    assert.doesNotMatch(text, /Ctrl\+O|more diff/);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  });
}

for (const width of [200, 80]) {
  test(`collapsed budget excludes metadata and preserves full source lines at width ${width}`, () => {
    const diff = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,2 @@",
      `-${"old content ".repeat(60)}OLD_END`,
      `+${"new content ".repeat(80)}NEW_END`,
      " shared",
      "@@ -20 +20 @@",
      "-HIDDEN_OLD",
      "+HIDDEN_NEW",
    ].join("\n");
    const text = renderEditDiffResult(
      { diff },
      { expanded: false },
      { ...DEFAULT_TOOL_DISPLAY_CONFIG, diffCollapsedLines: width >= 120 ? 1 : 2 },
      theme,
      "",
    )
      .render(width)
      .map(stripAllEscapes)
      .join("\n");
    assert.match(text, /example\.ts/);
    assert.match(text, /OLD_END/);
    assert.match(text, /NEW_END/);
    assert.doesNotMatch(text, /shared|HIDDEN|@@ -20/);
    assert.match(text, /1 more hunk/);
    assert.match(text, /Ctrl\+O to expand/);
  });
}

test("collapsed write preview preserves wrapped additions within its source-line budget", () => {
  const text = renderWriteDiffResult(
    `${"first content ".repeat(50)}FIRST_END\nSECOND\nHIDDEN`,
    { expanded: false, filePath: "new.txt" },
    { ...DEFAULT_TOOL_DISPLAY_CONFIG, diffCollapsedLines: 2 },
    theme,
    "",
  )
    .render(80)
    .map(stripAllEscapes)
    .join("\n");
  assert.match(text, /FIRST_END/);
  assert.match(text, /SECOND/);
  assert.doesNotMatch(text, /HIDDEN/);
  assert.match(text, /1 more diff line/);
});

test("expanded diff retains its terminal-row cap", () => {
  const lines = renderEditDiffResult(
    { diff: `@@ -0,0 +1 @@\n+${"long content ".repeat(100)}AFTER_CAP` },
    { expanded: true },
    { ...DEFAULT_TOOL_DISPLAY_CONFIG, expandedPreviewMaxLines: 4 },
    theme,
    "",
  )
    .render(80)
    .map(stripAllEscapes);
  assert.ok(lines.length <= 9);
  assert.doesNotMatch(lines.join("\n"), /AFTER_CAP/);
  assert.match(lines.join("\n"), /more diff lines/);
});
