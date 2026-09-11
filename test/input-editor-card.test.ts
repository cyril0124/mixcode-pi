import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "../src/ui/app-editor.js";
import { themeForId } from "../src/ui/themes.js";

function fixture(rows = 40) {
  const state = createInitialState("/repo");
  const tab = createTab(1, "card", "/repo", {
    title: "Agent-1",
    currentContextTokens: 12_300,
    contextLimit: 200_000,
  });
  state.tabs = [tab];
  state.activeTabId = tab.sessionId;
  const terminal = { rows, columns: 70 };
  const tui = { terminal, requestRender() {}, setFocus() {} } as unknown as TUI;
  const editor = new CompactPromptEditor(
    tui,
    editorThemeFor(themeForId(state.theme)),
    { paddingX: 1 },
    state,
  );
  const slot = new EditorSlot(tui, editor, state);
  slot.focused = true;
  return { editor, slot, state, tab, terminal };
}

function plain(line: string): string {
  return line.replaceAll(CURSOR_MARKER, "").replace(/\x1b\[[0-9;:]*m/g, "");
}

test("default editor paints a rounded card with aligned identity and context", () => {
  const { slot } = fixture();
  const lines = slot.render(70).map(plain);
  assert.match(lines[0]!, /^╭─+ Agent-1 · 12\.3k\/200k ─╮$/);
  assert.doesNotMatch(slot.render(70).join("\n"), /\x1b\[(?:4[0-7]|48)(?:;[^m]*)?m/);
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^│ {2}.*Describe your next change.*@ files.*\/ commands/);
  assert.equal(lines[2], `╰${"─".repeat(68)}╯`);
  for (const line of lines) assert.equal(visibleWidth(line), 70);
});

test("empty agent input shows Home and widget shortcuts only while they apply", () => {
  const { slot, state } = fixture();
  const empty = slot.render(100).map(plain);
  assert.match(empty[1]!, /@ files.*\/ commands.*← Home.*→ widgets/);
  assert.equal(empty.at(-1), `╰${"─".repeat(98)}╯`);
  slot.setText("draft");
  assert.doesNotMatch(slot.render(100).map(plain).join("\n"), /← Home|→ widgets/);
  state.activeTabId = "home";
  assert.doesNotMatch(slot.render(100).map(plain).join("\n"), /← Home|→ widgets/);
});

test("card keeps the focused cursor and typed Unicode inside its frame after resizing", () => {
  const { slot, terminal } = fixture();
  slot.setText("输入框 café 👩‍💻 and a long line that wraps across the editor");
  for (const width of [70, 32, 16, 5, 2, 1]) {
    terminal.columns = width;
    const lines = slot.render(width);
    assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  assert.equal(slot.getText(), "输入框 café 👩‍💻 and a long line that wraps across the editor");
});

test("card height follows draft lines without padding at any terminal height", () => {
  const { slot, terminal } = fixture();
  for (const rows of [40, 20]) {
    terminal.rows = rows;
    slot.setText("draft");
    const compact = slot.render(70).map(plain);
    assert.equal(compact.length, 3);
    assert.match(compact[1]!, /draft/);
    assert.equal(compact[2], `╰${"─".repeat(68)}╯`);
    slot.setText("draft\nsecond line");
    const multiline = slot.render(70).map(plain);
    assert.equal(multiline.length, 4);
    assert.match(multiline[2]!, /second line/);
    assert.equal(multiline[3], `╰${"─".repeat(68)}╯`);
  }
});

test("scrolling a long draft keeps its title and hidden-line indicators", () => {
  const { slot } = fixture(20);
  slot.setText(Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n"));
  const lines = slot.render(70).map(plain);
  assert.match(lines[0]!, /Agent-1/);
  assert.match(lines[0]!, /↑ 14/);
  assert.match(lines.at(-2)!, /line-19/);
  assert.match(lines.at(-1)!, /^╰/);
});

test("completion stays outside the card and Tab accepts the selected command", async () => {
  const { slot } = fixture();
  slot.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        { name: "theme", description: "Change theme" },
        { name: "tree", description: "Browse history" },
      ],
      "/repo",
    ),
  );
  slot.handleInput("/");
  for (let attempt = 0; attempt < 50 && !slot.isShowingAutocomplete(); attempt++)
    await Bun.sleep(10);
  assert.equal(slot.isShowingAutocomplete(), true);
  const lines = slot.render(70).map(plain);
  const bottom = lines.findIndex((line) => line.startsWith("╰"));
  assert.equal(lines[bottom], `╰${"─".repeat(68)}╯`);
  assert.ok(
    lines.slice(bottom + 1).some((line) => /theme\s+Change theme/.test(line)),
    lines.join("\n"),
  );
  for (const line of lines) assert.equal(visibleWidth(line), 70);
  slot.handleInput("\t");
  assert.equal(slot.getText(), "/theme ");
  assert.equal(slot.isShowingAutocomplete(), false);
});

test("mouse clicks reach the Unicode draft after terminal resizing", () => {
  const { slot, editor, terminal } = fixture();
  slot.setText("中文abc");
  for (const rows of [40, 20]) {
    terminal.rows = rows;
    const lines = slot.render(70).map(plain);
    const row = lines.findIndex((line) => line.includes("中文abc"));
    editor.handleMouse({
      type: "click",
      button: "left",
      x: 6,
      y: row,
      screenX: 6,
      screenY: row,
      width: 70,
      height: lines.length,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  }
});

test("narrow cards omit the ordinary send hint while preserving the draft", () => {
  const { slot } = fixture();
  slot.setText("draft");
  const lines = slot.render(20).map(plain);
  assert.ok(lines.some((line) => line.includes("draft")));
  assert.doesNotMatch(lines.join("\n"), /enter send|@ files|\/ commands/);
  for (const line of lines) assert.equal(visibleWidth(line), 20);
});

test("card edges follow thinking changes with Vim color taking precedence", () => {
  const { slot, tab, state } = fixture();
  for (const themeId of [state.theme, "catppuccin"]) {
    state.theme = themeId;
    const theme = themeForId(themeId);
    for (const [vimMode, thinkingLevel] of [
      [false, "low"],
      [false, "high"],
      [true, "high"],
      [true, "low"],
      [false, "low"],
    ] as const) {
      tab.vimMode = vimMode;
      tab.thinkingLevel = thinkingLevel;
      const frame = vimMode ? theme.vimBorder : theme.thinkingBorder(thinkingLevel);
      const lines = slot.render(70);
      assert.ok(lines[0]!.startsWith(frame("╭─")));
      assert.ok(lines[0]!.endsWith(frame("─╮")));
      assert.ok(lines[1]!.startsWith(frame("│")));
      assert.ok(lines[1]!.endsWith(frame("│")));
      assert.ok(lines.at(-1)!.startsWith(frame("╰─")));
      assert.ok(lines.at(-1)!.endsWith(frame("─╯")));
    }
  }
});

test("mode badges stay on the left while identity and context stay on the right", () => {
  const { slot, tab } = fixture();
  tab.vimMode = true;
  tab.zenMode = true;
  tab.customBasePrompt = true;
  const top = plain(slot.render(90)[0]!);
  assert.match(top, /^╭─ \[VIM\] \[ZEN\] \[sys\] ─+ Agent-1 · 12\.3k\/200k ─╮$/);
  for (const width of [90, 40, 20, 8]) {
    for (const line of slot.render(width)) assert.equal(visibleWidth(line), width);
  }
  tab.vimMode = false;
  slot.setText("!pwd");
  assert.match(plain(slot.render(90)[0]!), /^╭─ \[SHELL\] \[ZEN\] \[sys\] ─+ Agent-1/);
});

test("bottom border stays free of shortcuts across idle, running, and thinking states", () => {
  const { slot, tab, state } = fixture();
  for (const status of ["idle", "running", "thinking"] as const) {
    tab.status = status;
    for (const text of ["", "draft", "!pwd"]) {
      slot.setText(text);
      assert.equal(slot.render(100).map(plain).at(-1), `╰${"─".repeat(98)}╯`);
    }
  }
  state.activeTabId = "home";
  assert.equal(slot.render(100).map(plain).at(-1), `╰${"─".repeat(98)}╯`);
});

test("read-only and shell cards label the mode without displaying shortcut hints on the border", () => {
  const { slot, tab } = fixture();
  tab.vimMode = true;
  const readOnlyLines = slot.render(70).map(plain);
  const readOnly = readOnlyLines.join("\n");
  assert.equal(readOnlyLines.at(-1), `╰${"─".repeat(68)}╯`);
  assert.match(readOnly, /Vim:.*j\/k scroll.*q exit/);
  assert.match(readOnly, /\[VIM\]/);
  assert.doesNotMatch(readOnly, /send/);
  tab.vimMode = false;
  slot.setText("!pwd");
  const shell = slot.render(70).map(plain).join("\n");
  assert.match(shell, /SHELL/);
  assert.equal(shell.split("\n").at(-1), `╰${"─".repeat(68)}╯`);
});
