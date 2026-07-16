import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/ui/rendering/markdown.js";
import { renderMermaidASCII } from "../src/ui/rendering/mermaid.js";

test("renderMermaidASCII draws flowchart boxes and arrows", () => {
  const out = renderMermaidASCII("flowchart LR\n  A[Start] --> B[End]", 80).join("\n");
  assert.match(out, /Start/);
  assert.match(out, /End/);
  assert.match(out, /[─┌┐└┘│▶]/);
});

test("renderMermaidASCII draws sequence participants and messages", () => {
  const out = renderMermaidASCII("sequenceDiagram\n  A->>B: hi", 80).join("\n");
  assert.match(out, /A/);
  assert.match(out, /B/);
  assert.match(out, /hi/);
});

test("renderMermaidASCII falls back for unsupported diagram types", () => {
  const lines = renderMermaidASCII("gantt\n  title plan", 80);
  const out = lines.join("\n");
  assert.match(out, /mermaid: gantt/);
  assert.match(out, /title plan/);
  assert.match(out, /[╭╰]/);
});

test("renderMarkdown intercepts mermaid fences when enabled", () => {
  const md = ["```mermaid", "flowchart LR", "  A[Start] --> B[End]", "```"].join("\n");
  const out = renderMarkdown(md, 80).join("\n");
  assert.match(out, /Start/);
  assert.match(out, /End/);
  assert.doesNotMatch(out, /flowchart LR/);
});

test("renderMarkdown keeps mermaid as plain code when disabled", () => {
  const md = ["```mermaid", "flowchart LR", "  A[Start] --> B[End]", "```"].join("\n");
  const out = renderMarkdown(md, 80, { renderMermaid: false }).join("\n");
  assert.match(out, /flowchart LR/);
  assert.match(out, /A\[Start\]/);
});
