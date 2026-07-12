import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInput } from "../src/core/commands.js";

// Skill/template expansion is owned by Pi's native prompt pipeline
// (AgentSession.prompt -> _expandSkillCommand / expandPromptTemplate). MixCode
// only routes input and renders the resulting <skill> block. These tests cover
// the routing decision and the chat rendering of Pi-produced skill blocks.

test("parseInput routes /skill: as prompt kind", () => {
  const result = parseInput("/skill:my-skill do something");
  assert.equal(result.kind, "prompt");
  assert.equal(result.args, "/skill:my-skill do something");
});

test("parseInput routes /skill: without args as prompt kind", () => {
  const result = parseInput("/skill:lint");
  assert.equal(result.kind, "prompt");
  assert.equal(result.args, "/skill:lint");
});

test("parseInput still routes other / commands as local-command", () => {
  const result = parseInput("/models");
  assert.equal(result.kind, "local-command");
  assert.equal(result.command, "models");
});

test("renderChat shows skill block collapsed by default", async () => {
  // Dynamically import to avoid circular issues
  const { renderChat } = await import("../src/ui/rendering/chat.js");
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const skillText =
    '<skill name="my-skill" location="/tmp/my-skill/SKILL.md">\nReferences are relative to /tmp/my-skill.\n\n# My Skill\n\nDo something.\n</skill>\n\nfix the bug';
  const chat = [{ role: "user" as const, text: skillText }];
  const rendered = stripAnsi(renderChat(chat, 80).join("\n"));
  // Collapsed: should show [skill] name and ctrl+o hint
  assert.match(rendered, /\[skill\]/);
  assert.match(rendered, /my-skill/);
  assert.match(rendered, /ctrl\+o to expand/);
  // User args should be shown
  assert.match(rendered, /fix the bug/);
  // Skill content should NOT be shown in collapsed state
  assert.doesNotMatch(rendered, /Do something\./);
});

test("renderChat shows skill block expanded when toolsExpanded is true", async () => {
  const { renderChat } = await import("../src/ui/rendering/chat.js");
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const skillText =
    '<skill name="my-skill" location="/tmp/my-skill/SKILL.md">\nReferences are relative to /tmp/my-skill.\n\n# My Skill\n\nDo something.\n</skill>\n\nfix the bug';
  const chat = [{ role: "user" as const, text: skillText }];
  const tab = { extensionUi: { toolsExpanded: true } } as any;
  const rendered = stripAnsi(renderChat(chat, 80, undefined, tab).join("\n"));
  // Expanded: should show skill content
  assert.match(rendered, /\[skill\]/);
  assert.match(rendered, /my-skill/);
  assert.match(rendered, /Do something\./);
  // Should NOT show the expand hint
  assert.doesNotMatch(rendered, /ctrl\+o to expand/);
  // User args should still be shown
  assert.match(rendered, /fix the bug/);
});
