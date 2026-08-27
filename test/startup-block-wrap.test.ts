// Regression test: the startup resource summary ([Context]/[Skills]/[Extensions])
// must wrap long comma-separated lists instead of hard-truncating them with "...".
// Previously renderStartupBlock padded each line via padLine, which clipped any
// line wider than the terminal, hiding most skills/extensions behind an ellipsis.
// The summary now renders from tab.startupSummary via renderStartupBlock directly
// (agent-surface header slot), not through the chat block renderer.

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStartupBlock } from "../src/ui/rendering/chat.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const WIDTH = 40;

function buildStartupSummary(): string {
  const skills = Array.from({ length: 12 }, (_, i) => `skill-name-${i}`);
  return ["[Context]", "  ~/AGENTS.md", "", "[Skills]", `  ${skills.join(", ")}`, ""].join("\n");
}

test("startup block wraps long skill lists instead of truncating", () => {
  const rendered = renderStartupBlock(buildStartupSummary(), WIDTH).map(stripAnsi);
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

test("startup block paints [Skill conflicts] in the prominent warning color", () => {
  // Default render theme (pi-dark): warning #f0c674, tool #d4a656, success #b5bd68.
  const WARNING = "\x1b[38;2;240;198;116m";
  const TOOL = "\x1b[38;2;212;166;86m";
  const SUCCESS = "\x1b[38;2;181;189;104m";
  const summary = [
    "[Skills]",
    "  dup-skill",
    "",
    "[Skill conflicts]",
    '  "dup-skill" collision:',
    "    \u2713 auto (user) ~/.pi/agent/skills/dup-skill/SKILL.md",
    "    \u2717 ~/.agents/skills/dup-skill/SKILL.md (skipped)",
    "",
  ].join("\n");
  const rendered = renderStartupBlock(summary, 120);

  const conflictHeader = rendered.find((l) => stripAnsi(l).trim() === "[Skill conflicts]");
  assert.ok(conflictHeader, "conflict header line present");
  // The conflict header uses warning, not the muted tool color used elsewhere.
  assert.ok(conflictHeader.includes(WARNING), "conflict header is warning-colored");
  assert.ok(!conflictHeader.includes(TOOL), "conflict header is not tool-colored");

  // A regular section header keeps the muted tool color.
  const skillsHeader = rendered.find((l) => stripAnsi(l).trim() === "[Skills]");
  assert.ok(skillsHeader?.includes(TOOL), "informational header stays tool-colored");

  // Winner marker uses success; loser marker uses warning.
  const winner = rendered.find((l) => stripAnsi(l).includes("\u2713 auto (user)"));
  assert.ok(winner?.includes(SUCCESS), "winner marker is success-colored");
  const loser = rendered.find((l) => stripAnsi(l).includes("(skipped)"));
  assert.ok(loser?.includes(WARNING), "loser marker is warning-colored");
});
