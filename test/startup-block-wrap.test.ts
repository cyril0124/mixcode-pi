// Regression test: the startup resource summary ([Context]/[Skills]/[Extensions])
// must wrap long comma-separated lists instead of hard-truncating them with "...".
// Previously renderStartupBlock padded each line via padLine, which clipped any
// line wider than the terminal, hiding most skills/extensions behind an ellipsis.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatLine } from "../src/index.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const WIDTH = 40;

function buildStartupLine(): ChatLine {
  const skills = Array.from({ length: 12 }, (_, i) => `skill-name-${i}`);
  const text = [
    "[Context]",
    "  ~/AGENTS.md",
    "",
    "[Skills]",
    `  ${skills.join(", ")}`,
    "",
  ].join("\n");
  return { role: "startup", text };
}

test("startup block wraps long skill lists instead of truncating", () => {
  const line = buildStartupLine();
  const rendered = renderChatBlock(line, WIDTH).map(stripAnsi);
  const joined = rendered.join("\n");

  // No hard truncation marker should appear.
  assert.ok(
    !rendered.some((l) => l.includes("...")),
    `expected no ellipsis truncation, got:\n${joined}`,
  );

  // The full list must remain visible, including the last item that would have
  // been clipped at width 40 before wrapping.
  assert.ok(joined.includes("skill-name-11"), `expected last skill visible, got:\n${joined}`);

  // Section headers stay intact.
  assert.ok(joined.includes("[Skills]"));
  assert.ok(joined.includes("[Context]"));

  // Every rendered line must fit within the terminal width.
  for (const l of rendered) {
    assert.ok(l.length <= WIDTH, `line exceeds width ${WIDTH}: ${JSON.stringify(l)}`);
  }
});
