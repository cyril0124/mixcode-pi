import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatLine } from "../src/agent/runtime.js";
import { stripAnsi } from "../src/index.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { activeRenderTheme } from "../src/ui/rendering/context.js";
import { renderMarkdown } from "../src/ui/rendering/markdown.js";

const FLOW = ["```mermaid", "flowchart LR", "  A[Start] --> B[End]", "```"].join("\n");

test("renderMarkdown draws flowchart mermaid fences via Pi transformer", () => {
  const out = renderMarkdown(FLOW, 80).join("\n");
  assert.match(out, /Start/);
  assert.match(out, /End/);
  assert.doesNotMatch(out, /flowchart LR/);
  assert.match(out, /[─┌┐└┘│▶─]/);
});

test("renderMarkdown draws sequence mermaid fences", () => {
  const md = ["```mermaid", "sequenceDiagram", "  A->>B: hi", "```"].join("\n");
  const out = renderMarkdown(md, 80).join("\n");
  assert.match(out, /A/);
  assert.match(out, /B/);
  assert.match(out, /hi/);
});

test("renderMarkdown draws class mermaid fences", () => {
  const md = ["```mermaid", "classDiagram", "  class Animal", "  Animal : +age", "```"].join("\n");
  const out = renderMarkdown(md, 80).join("\n");
  assert.match(out, /Animal/);
  assert.match(out, /\+age/);
});

test("renderMarkdown draws state mermaid fences", () => {
  const md = ["```mermaid", "stateDiagram-v2", "  [*] --> Still", "  Still --> [*]", "```"].join(
    "\n",
  );
  const out = renderMarkdown(md, 80).join("\n");
  assert.match(out, /Still/);
});

test("renderMarkdown draws er mermaid fences", () => {
  const md = ["```mermaid", "erDiagram", "  CUSTOMER ||--o{ ORDER : places", "```"].join("\n");
  const out = renderMarkdown(md, 80).join("\n");
  assert.match(out, /CUSTOMER/);
  assert.match(out, /ORDER/);
  assert.match(out, /places/);
});

test("renderMarkdown keeps unsupported mermaid as code fence", () => {
  const md = ["```mermaid", "gantt", "  title plan", "```"].join("\n");
  const out = renderMarkdown(md, 80).join("\n");
  assert.match(out, /gantt/);
  assert.match(out, /title plan/);
});

test("renderMarkdown keeps mermaid as plain code when mode is off", () => {
  const out = renderMarkdown(FLOW, 80, { mermaidRenderingMode: "off" }).join("\n");
  assert.match(out, /flowchart LR/);
  assert.match(out, /A\[Start\]/);
});

test("renderMarkdown final mode skips diagrams while streaming", () => {
  const streaming = renderMarkdown(FLOW, 80, {
    mermaidRenderingMode: "final",
    isStreaming: true,
  }).join("\n");
  assert.match(streaming, /flowchart LR/);

  const final = renderMarkdown(FLOW, 80, {
    mermaidRenderingMode: "final",
    isStreaming: false,
  }).join("\n");
  assert.doesNotMatch(final, /flowchart LR/);
  assert.match(final, /Start/);
});

test("renderMarkdown keeps mermaid as plain code in thinking blocks", () => {
  const out = renderMarkdown(FLOW, 80, { messageType: "assistant-thinking" }).join("\n");
  assert.match(out, /flowchart LR/);
  assert.match(out, /A\[Start\]/);
});

test("renderChatBlock invalidates its cache when Mermaid mode changes", () => {
  const line = { role: "assistant", text: FLOW } satisfies ChatLine;

  const disabled = stripAnsi(
    renderChatBlock(line, 80, undefined, activeRenderTheme, {
      mermaidRenderingMode: "off",
    }).join("\n"),
  );
  const enabled = stripAnsi(
    renderChatBlock(line, 80, undefined, activeRenderTheme, {
      mermaidRenderingMode: "streaming",
    }).join("\n"),
  );

  assert.match(disabled, /flowchart LR/);
  assert.doesNotMatch(enabled, /flowchart LR/);
  assert.match(enabled, /Start/);
  assert.match(enabled, /End/);
});

test("renderMarkdown renders inline and block LaTeX as Unicode", () => {
  const inline = renderMarkdown("area $x^2$", 80).join("\n");
  assert.match(inline, /x²|x\^2/);
  assert.doesNotMatch(inline, /\$x\^2\$/);

  const block = renderMarkdown("$$\\frac{a}{b}$$", 80).join("\n");
  assert.match(block, /a/);
  assert.match(block, /b/);
  assert.doesNotMatch(block, /\\frac/);
});
