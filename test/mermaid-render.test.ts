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

test("renderMermaidASCII draws class diagram boxes and members", () => {
  const out = renderMermaidASCII("classDiagram\n  class Animal\n  Animal : +age", 80).join(
    "\n",
  );
  assert.match(out, /Animal/);
  assert.match(out, /\+age/);
  assert.match(out, /[─┌┐└┘│]/);
});

test("renderMermaidASCII draws state diagram nodes and transitions", () => {
  const out = renderMermaidASCII("stateDiagram-v2\n  [*] --> Still\n  Still --> [*]", 80).join(
    "\n",
  );
  assert.match(out, /Still/);
  assert.match(out, /[─│╭╮╰╯▼●]/);
});

test("renderMermaidASCII draws er diagram entities and relationship", () => {
  const out = renderMermaidASCII("erDiagram\n  CUSTOMER ||--o{ ORDER : places", 80).join("\n");
  assert.match(out, /CUSTOMER/);
  assert.match(out, /ORDER/);
  assert.match(out, /places/);
  assert.match(out, /[─┌┐└┘│]/);
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
