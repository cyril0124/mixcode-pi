import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAllHighlightLanguages } from "../src/ui/pi-theme-api.js";
import { renderMarkdown, setMarkdownCodeBlockIndent } from "../src/ui/rendering/markdown.js";

function syntaxColors(text: string): Set<string> {
  return new Set(text.match(/\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/g) ?? []);
}

test("renderMarkdown highlights fenced code blocks with syntax colors", () => {
  const md = [
    "```javascript",
    "function greet(name) {",
    '  const msg = "hi " + name;',
    "  return msg;",
    "}",
    "```",
  ].join("\n");

  const lines = renderMarkdown(md, 80);
  const body = lines.join("\n");

  assert.ok(syntaxColors(body).size > 1, "expected per-token syntax highlight colors");
});

test("renderMarkdown highlights code blocks inside a thinking-styled block", () => {
  // Thinking blocks pass a custom color + italic; highlighting must still run
  // for fenced code (this is the originally reported regression).
  const thinkingColor = (t: string) => `\x1b[38;2;128;128;128m${t}\x1b[39m`;
  const md = ["```python", "def f(x):", "    return x + 1", "```"].join("\n");

  const lines = renderMarkdown(md, 80, { color: thinkingColor, italic: true });
  const body = lines.join("\n");

  assert.ok(syntaxColors(body).size > 1, "thinking code blocks must be highlighted too");
});

test("renderMarkdown highlights diff fences once full languages are loaded", async () => {
  // diff is not in pi's eager highlight.js language set; it only registers
  // via loadAllHighlightLanguages (kicked off after first paint in
  // interactive-app). Without it, diff fences render in one uniform
  // mdCodeBlock color.
  await loadAllHighlightLanguages();
  const md = ["```diff", "-local a = 1", "+local a = 2", "```"].join("\n");
  const body = renderMarkdown(md, 80).join("\n");
  assert.ok(syntaxColors(body).size > 1, "diff deletion/addition lines must get distinct colors");
});

function leadingSpaces(line: string): number {
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
  return visible.length - visible.trimStart().length;
}

test("renderMarkdown honors markdown.codeBlockIndent from settings", () => {
  const md = ["```diff", "+++ b/file.lua", "```"].join("\n");
  try {
    // Default ("  "): code content sits 2 cells right of the fence line.
    const indented = renderMarkdown(md, 80);
    assert.equal(leadingSpaces(indented[1] ?? ""), leadingSpaces(indented[0] ?? "") + 2);

    // "": code content aligns with the fence, so a copied block pastes as
    // valid flush Markdown (GitHub diff highlighting needs +/- at column 0).
    setMarkdownCodeBlockIndent("");
    const flush = renderMarkdown(md, 80);
    assert.equal(leadingSpaces(flush[1] ?? ""), leadingSpaces(flush[0] ?? ""));
  } finally {
    setMarkdownCodeBlockIndent("  ");
  }
});
