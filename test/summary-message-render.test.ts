import assert from "node:assert/strict";
import { test } from "node:test";
import { getMarkdownTheme as getPiMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ensureExtensionThemeInitialized } from "../src/agent/runtime-extension-theme.js";
import { resolvePiTheme, themeForId } from "../src/ui/themes.js";
import { setMarkdownCodeBlockIndent } from "../src/ui/rendering/markdown.js";
import { createTab } from "../src/core/defaults.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { summaryChat } from "./helpers/message-cards.js";

test("summary messages retain the session entry metadata required by Pi", () => {
  const [branch, compaction] = summaryChat();
  assert.deepEqual(branch?.summaryMessage, {
    role: "branchSummary",
    summary: "Retain the **design decision**.",
    fromId: "source-branch",
    timestamp: Date.parse("2026-09-09T08:00:00.000Z"),
  });
  assert.deepEqual(compaction?.summaryMessage, {
    role: "compactionSummary",
    summary: "Retain the **design decision**.",
    tokensBefore: 12_000,
    timestamp: Date.parse("2026-09-09T08:01:00.000Z"),
  });
});

test("cards follow the rendering theme without changing host theme or keybindings", () => {
  ensureExtensionThemeInitialized();
  const headingBefore = getPiMarkdownTheme().heading("host heading");
  const bindingsBefore = getKeybindings().getKeys("tui.input.submit");
  const lines = [
    {
      role: "user" as const,
      text: '<skill name="theme" location="/tmp/theme/SKILL.md">\nbody\n</skill>',
    },
    ...summaryChat(),
  ];
  for (const [index, label] of ["skill", "branch", "compaction"].entries()) {
    const line = lines[index]!;
    for (const name of ["light", "dark", "light"]) {
      const rendered = renderChatBlock(line, 80, undefined, themeForId(name)).join("\n");
      // The skill label includes a trailing space inside its color span; assert
      // the label's foreground rather than where Pi closes that span.
      const expected = resolvePiTheme(name)!
        .fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m`)
        .replace(/\x1b\[39m$/, "");
      assert.ok(rendered.includes(expected), `missing ${name} ${label} label color`);
      assert.equal(getPiMarkdownTheme().heading("host heading"), headingBefore);
      assert.deepEqual(getKeybindings().getKeys("tui.input.submit"), bindingsBefore);
    }
  }
});

test("expanded cards retain the configured Markdown code indentation", () => {
  const content = "```text\ncard code\n```";
  const tab = createTab(1, "indent", process.cwd());
  tab.extensionUi.toolsExpanded = true;
  const positions: number[][] = [];
  try {
    for (const indent of ["", "    "]) {
      setMarkdownCodeBlockIndent(indent);
      const lines = [
        {
          role: "user" as const,
          text: `<skill name="indent" location="/tmp/indent/SKILL.md">\n${content}\n</skill>`,
        },
        ...summaryChat(content),
      ];
      positions.push(
        lines.map((line) => {
          const rendered = renderChatBlock(line, 80, tab).map(stripTerminalSequences);
          const codeLine = rendered.find((row) => row.includes("card code"));
          assert.ok(codeLine);
          return codeLine.indexOf("card code");
        }),
      );
    }
    assert.deepEqual(
      positions[1],
      positions[0]!.map((position) => position + 4),
    );
  } finally {
    setMarkdownCodeBlockIndent("  ");
  }
});

for (const [index, label] of [
  [0, "branch"],
  [1, "compaction"],
] as const) {
  test(`${label} summary survives collapse, expansion, and return to collapse`, () => {
    const line = summaryChat()[index]!;
    const tab = createTab(1, "summary-test", process.cwd());
    const collapsed = stripTerminalSequences(renderChatBlock(line, 80, tab).join("\n"));
    assert.match(collapsed, new RegExp(`\\[${label}\\]`));
    assert.doesNotMatch(collapsed, /design decision/);
    assert.match(collapsed, /ctrl\+o to expand/);
    tab.extensionUi.toolsExpanded = true;
    const expanded = stripTerminalSequences(renderChatBlock(line, 80, tab).join("\n"));
    assert.match(expanded, /design decision/);
    assert.doesNotMatch(expanded, /\*\*design decision\*\*|to expand/);
    tab.extensionUi.toolsExpanded = false;
    assert.equal(stripTerminalSequences(renderChatBlock(line, 80, tab).join("\n")), collapsed);
  });

  test(`${label} summary renders Mermaid in expanded content`, () => {
    const line = summaryChat("```mermaid\nflowchart LR\n A[Start] --> B[End]\n```")[index]!;
    const tab = createTab(1, "diagram", process.cwd());
    tab.extensionUi.toolsExpanded = true;
    const rendered = stripTerminalSequences(renderChatBlock(line, 80, tab).join("\n"));
    assert.match(rendered, /Start/);
    assert.match(rendered, /End/);
    assert.doesNotMatch(rendered, /flowchart LR/);
  });

  test(`${label} summary fits a narrow viewport`, () => {
    const line = summaryChat()[index]!;
    const tab = createTab(1, "narrow", process.cwd());
    for (const expanded of [false, true]) {
      tab.extensionUi.toolsExpanded = expanded;
      const lines = renderChatBlock(line, 24, tab);
      assert.ok(lines.every((row) => visibleWidth(row) <= 24));
    }
  });
}

test("compaction displays the recorded token count including zero", () => {
  for (const tokens of [0, 12_000]) {
    const line = summaryChat(undefined, tokens)[1]!;
    const tab = createTab(1, "tokens", process.cwd());
    for (const expanded of [false, true]) {
      tab.extensionUi.toolsExpanded = expanded;
      const rendered = stripTerminalSequences(renderChatBlock(line, 80, tab).join("\n"));
      assert.ok(rendered.includes(`Compacted from ${tokens.toLocaleString()} tokens`), rendered);
    }
  }
});
