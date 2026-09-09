import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type KeybindingsManager,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../src/agent/runtime-extension-theme.js";
import type { ChatLine } from "../src/agent/runtime-types.js";
import { createTab } from "../src/core/defaults.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { summaryChat } from "./helpers/message-cards.js";
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

test("renderConversation shows skill block collapsed by default", async () => {
  // Dynamically import to avoid circular issues
  const { renderConversation } = await import("../src/ui/rendering/chat.js");
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const skillText =
    '<skill name="my-skill" location="/tmp/my-skill/SKILL.md">\nReferences are relative to /tmp/my-skill.\n\n# My Skill\n\nDo something.\n</skill>\n\nfix the bug';
  const chat = [{ role: "user" as const, text: skillText }];
  const rendered = stripAnsi(renderConversation(chat, 80).join("\n"));
  // Collapsed: should show [skill] name and ctrl+o hint
  assert.match(rendered, /\[skill\]/);
  assert.match(rendered, /my-skill/);
  assert.match(rendered, /ctrl\+o to expand/);
  // User args should be shown
  assert.match(rendered, /fix the bug/);
  // Skill content should NOT be shown in collapsed state
  assert.doesNotMatch(rendered, /Do something\./);
});

test("renderConversation shows skill block expanded when toolsExpanded is true", async () => {
  const { renderConversation } = await import("../src/ui/rendering/chat.js");
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const skillText =
    '<skill name="my-skill" location="/tmp/my-skill/SKILL.md">\nReferences are relative to /tmp/my-skill.\n\n# My Skill\n\nDo something.\n</skill>\n\nfix the bug';
  const chat = [{ role: "user" as const, text: skillText }];
  const tab = createTab(1, "skill-expanded", process.cwd());
  tab.extensionUi.toolsExpanded = true;
  const rendered = stripAnsi(renderConversation(chat, 80, tab).join("\n"));
  // Expanded: should show skill content
  assert.match(rendered, /\[skill\]/);
  assert.match(rendered, /my-skill/);
  assert.match(rendered, /Do something\./);
  // Should NOT show the expand hint
  assert.doesNotMatch(rendered, /ctrl\+o to expand/);
  // User args should still be shown
  assert.match(rendered, /fix the bug/);
});

const SKILL =
  '<skill name="example" location="/tmp/example/SKILL.md">\nUse **careful changes**.\n</skill>';

test("card hints follow rebound keys even after their lines have been cached", () => {
  const manager = MIXCODE_EXTENSION_KEYBINDINGS_MANAGER as unknown as KeybindingsManager;
  const previous = manager.getUserBindings();
  const cards = [{ role: "user" as const, text: SKILL }, ...summaryChat()];
  try {
    manager.setUserBindings({ ...previous, "app.tools.expand": "ctrl+o" });
    for (const line of cards) {
      assert.match(
        stripTerminalSequences(renderChatBlock(line, 80).join("\n")),
        /ctrl\+o to expand/,
      );
    }
    manager.setUserBindings({ ...previous, "app.tools.expand": "ctrl+y" });
    for (const line of cards) {
      const rendered = stripTerminalSequences(renderChatBlock(line, 80).join("\n"));
      assert.match(rendered, /ctrl\+y to expand/);
      assert.doesNotMatch(rendered, /ctrl\+o/);
    }
  } finally {
    manager.setUserBindings(previous);
  }
});

test("skill clock stays on the card without arguments and on the user block with arguments", () => {
  const timestamp = Date.UTC(2026, 7, 9, 9, 7);
  const clock = new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const tab = createTab(1, "skill-clock", process.cwd());
  for (const expanded of [false, true]) {
    tab.extensionUi.toolsExpanded = expanded;
    for (const args of ["", "\n\nfix the bug"]) {
      const line = { role: "user" as const, text: SKILL + args, timestamp };
      const rows = renderChatBlock(line, 100, tab).map(stripTerminalSequences);
      const clockRow = rows.find((row) => row.includes(clock));
      assert.ok(clockRow, rows.join("\n"));
      assert.match(clockRow, args ? /fix the bug/ : /\[skill\]/);
      assert.doesNotMatch(clockRow, /\.\.\.|…/);
      assert.equal(rows.filter((row) => row.includes(clock)).length, 1);
      if (expanded) assert.match(rows.join("\n"), /careful changes/);
      for (const width of [12, 24]) {
        assert.ok(renderChatBlock(line, width, tab).every((row) => visibleWidth(row) <= width));
      }
    }
  }
});

test("skill attachments follow the card and respect image visibility", () => {
  const line: ChatLine = {
    role: "user",
    text: SKILL,
    images: [
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    ],
  };
  const shown = renderChatBlock(line, 80, undefined, undefined, { showImages: true }).join("\n");
  const hidden = renderChatBlock(line, 80, undefined, undefined, { showImages: false }).join("\n");
  assert.match(shown, /image\/png|\x1b_G|\x1b\]1337/);
  assert.doesNotMatch(hidden, /image\/png|\x1b_G|\x1b\]1337/);
  assert.match(stripTerminalSequences(hidden), /\[skill\] example/);
});

test("expanded skill retains Mermaid diagrams", () => {
  const text = SKILL.replace(
    "Use **careful changes**.",
    "```mermaid\nflowchart LR\n A[Start] --> B[End]\n```",
  );
  const tab = createTab(1, "skill-diagram", process.cwd());
  tab.extensionUi.toolsExpanded = true;
  const rendered = stripTerminalSequences(
    renderChatBlock({ role: "user", text }, 80, tab).join("\n"),
  );
  assert.match(rendered, /Start/);
  assert.match(rendered, /End/);
  assert.doesNotMatch(rendered, /flowchart LR/);
});
