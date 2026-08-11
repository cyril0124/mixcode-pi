import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/ui/rendering/markdown.js";

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
