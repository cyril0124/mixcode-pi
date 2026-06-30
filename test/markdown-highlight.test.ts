import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/ui/rendering/markdown.js";

// The SDK syntax highlighter (highlight.js via cli-highlight) emits 256-color
// SGR codes (\x1b[38;5;Nm). mixcode's truecolor themes only ever emit
// \x1b[38;2;R;G;Bm, so the presence of a 256-color foreground code in a code
// block is a reliable signal that real per-token syntax highlighting ran.
const SDK_HIGHLIGHT_256_COLOR = /\x1b\[38;5;\d+m/;

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

  assert.match(
    body,
    SDK_HIGHLIGHT_256_COLOR,
    "expected per-token syntax highlight colors in a JS code block",
  );
});

test("renderMarkdown highlights code blocks inside a thinking-styled block", () => {
  // Thinking blocks pass a custom color + italic; highlighting must still run
  // for fenced code (this is the originally reported regression).
  const thinkingColor = (t: string) => `\x1b[38;2;128;128;128m${t}\x1b[39m`;
  const md = ["```python", "def f(x):", "    return x + 1", "```"].join("\n");

  const lines = renderMarkdown(md, 80, { color: thinkingColor, italic: true });
  const body = lines.join("\n");

  assert.match(body, SDK_HIGHLIGHT_256_COLOR, "thinking code blocks must be highlighted too");
});
