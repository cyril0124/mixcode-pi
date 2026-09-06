import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { activateTab, closeAgentTab } from "../src/core/tabs.js";
import { renderTabBar, themeForId } from "./helpers/mixcode.js";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

// Track the SGR attributes on visible cells, including resets inside shimmer spans.
const styledCells = (rendered: string) => {
  let fg = "";
  let bg = "";
  let bold = false;
  let dim = false;
  let inverse = false;
  const cells: Array<{
    char: string;
    fg: string;
    bg: string;
    bold: boolean;
    dim: boolean;
    inverse: boolean;
  }> = [];
  for (let index = 0; index < rendered.length; index++) {
    const sgr = /^\x1b\[([0-9;]*)m/.exec(rendered.slice(index));
    if (sgr) {
      const codes = sgr[1]!.split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) {
          fg = bg = "";
          bold = dim = inverse = false;
        } else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) bold = dim = false;
        else if (code === 7) inverse = true;
        else if (code === 27) inverse = false;
        else if (code === 39) fg = "";
        else if (code === 49) bg = "";
        else if (code === 38 || code === 48) {
          const count = codes[i + 1] === 2 ? 5 : 3;
          const color = codes.slice(i, i + count).join(";");
          if (code === 38) fg = color;
          else bg = color;
          i += count - 1;
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          fg = String(code);
        }
      }
      index += sgr[0].length - 1;
      continue;
    }
    cells.push({ char: rendered[index]!, fg, bg, bold, dim, inverse });
  }
  return cells;
};

const foregroundOf = (paint: (text: string) => string): string => styledCells(paint("x"))[0]!.fg;

const titleCells = (line: string, title: string) => {
  const cells = styledCells(line);
  const start = cells
    .map((cell) => cell.char)
    .join("")
    .indexOf(title);
  assert.ok(start >= 0, `title missing: ${title}`);
  return cells.slice(start, start + title.length);
};

test("activateTab records agent recency and ignores Home", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo"),
    createTab(2, "s2", "/repo"),
    createTab(3, "s3", "/repo"),
  );
  activateTab(state, "s1");
  activateTab(state, "s2");
  activateTab(state, "s3");
  activateTab(state, "home");
  assert.deepEqual(state.recentAgentTabIds, ["s3", "s2", "s1"]);
  activateTab(state, "s1");
  assert.deepEqual(state.recentAgentTabIds, ["s1", "s3", "s2"]);
});

test("closing a recent agent drops it and shifts the queue", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo"),
    createTab(2, "s2", "/repo"),
    createTab(3, "s3", "/repo"),
  );
  activateTab(state, "s1");
  activateTab(state, "s2");
  activateTab(state, "s3");
  closeAgentTab(state, "s2");
  assert.deepEqual(state.recentAgentTabIds, ["s3", "s1"]);
});

test("stale session ids do not occupy recency ranks", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Alpha" }),
    createTab(2, "s2", "/repo", { title: "Beta" }),
  );
  activateTab(state, "s1");
  activateTab(state, "s2");
  // /clear replaces the live tab id in place and then activates the new id.
  state.tabs[1]!.sessionId = "s2-cleared";
  activateTab(state, "s2-cleared");
  activateTab(state, "home");
  assert.deepEqual(state.recentAgentTabIds, ["s2-cleared", "s1"]);
});

test("on Home the most recent agent uses recentTab, not idle tab", () => {
  const state = createInitialState("/repo");
  state.theme = "terminal";
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Alpha" }),
    createTab(2, "s2", "/repo", { title: "Beta" }),
  );
  activateTab(state, "s1");
  activateTab(state, "s2");
  activateTab(state, "home");
  const line = renderTabBar(state, 80, themeForId("terminal"))[0] ?? "";
  const recent = themeForId("terminal").recentTab(" - Beta ");
  assert.ok(line.includes(recent), "last agent on Home should use recentTab paint");
  assert.match(stripAnsi(line), /Beta/);
});

test("working active tab keeps the title readable", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker", status: "running" }));
  activateTab(state, "s1");
  const line = renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "";
  const plain = stripAnsi(line);
  assert.match(plain, /● Worker/);
  assert.ok(plain.includes("● Worker "), "working displays the chip text after the focus mark");
});

test("status glyphs retain their color without recoloring titles during the shimmer", () => {
  for (const themeId of ["mixcode-dark", "light", "terminal"]) {
    const theme = themeForId(themeId);
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo", { title: "Worker", status: "running" });
    state.tabs.push(tab);
    activateTab(state, "s1");
    const textFg = foregroundOf(theme.text);
    const accentFg = foregroundOf(theme.accent);
    const workingFg = foregroundOf(theme.workingFg);

    for (const phase of [0, 250, 600, 1200, 1800, 2400]) {
      tab.activatedAt = Date.now() - phase;
      const line = renderTabBar(state, 80, theme)[0]!;
      const glyph = styledCells(line).find((cell) => cell.char === "●")!;
      assert.equal(glyph.fg, workingFg, `${themeId}: status color at phase ${phase}`);
      for (const cell of titleCells(line, "Worker")) {
        assert.ok(
          cell.fg === textFg || (phase < 2000 && cell.fg === accentFg),
          `${themeId}: title color at phase ${phase}`,
        );
        assert.equal(
          cell.bold,
          styledCells(theme.bold("x"))[0]!.bold,
          `${themeId}: title bold at phase ${phase}`,
        );
      }
    }
  }
});

for (const themeId of [
  "mixcode-dark",
  "claude-warm",
  "tokyo-night",
  "catppuccin",
  "kanagawa",
  "rose-pine",
  "terminal",
  "dark",
  "light",
]) {
  test(`${themeId}: only the active tab receives the selection background`, () => {
    const state = createInitialState("/repo");
    state.tabs = ["Alpha", "Beta", "Gamma", "Delta"].map((title, index) =>
      createTab(index + 1, `s${index}`, "/repo", { title, status: "idle" }),
    );
    for (const id of ["s0", "s1", "s2"]) activateTab(state, id);
    state.tabs[2]!.activatedAt = Date.now() - 2400;
    const theme = themeForId(themeId);
    const selected = styledCells(theme.selectedBg("x"))[0]!;
    const normalBg = styledCells(`${theme.toolPendingBg.start}x${theme.toolPendingBg.end}`)[0]!.bg;
    const line = renderTabBar(state, 100, theme)[0]!;
    for (const title of ["Alpha", "Beta", "Gamma", "Delta", "MixCode Home"]) {
      const active = title === "Gamma";
      const fg = foregroundOf(
        title === "MixCode Home" ? theme.accent : title === "Delta" ? theme.muted : theme.text,
      );
      for (const cell of titleCells(line, title)) {
        assert.equal(cell.bg, active ? selected.bg : normalBg, `${title}: background`);
        assert.equal(cell.inverse, active && selected.inverse, `${title}: reverse video`);
        assert.equal(cell.fg, fg, `${title}: foreground`);
        if (active)
          assert.equal(cell.bold, styledCells(theme.bold("x"))[0]!.bold, `${title}: bold`);
      }
    }
    activateTab(state, "home");
    state.homeActivatedAt = Date.now() - 2400;
    const homeLine = renderTabBar(state, 100, theme)[0]!;
    for (const cell of titleCells(homeLine, "MixCode Home")) {
      assert.equal(cell.bg, selected.bg);
      assert.equal(cell.inverse, selected.inverse);
      assert.equal(cell.fg, foregroundOf(theme.text));
      assert.equal(cell.bold, styledCells(theme.bold("x"))[0]!.bold);
    }
  });
}

test("inactive status colors preserve muted titles except completed agents", () => {
  const state = createInitialState("/repo");
  const theme = themeForId("mixcode-dark");
  const statuses = ["running", "error", "done", "idle"] as const;
  state.tabs = statuses.map((status, index) =>
    createTab(index + 1, `s${index}`, "/repo", { status, title: `Worker${index}` }),
  );
  state.tabs[3]!.extensionUi.waitingForInputs = [{ id: "q", kind: "custom" }];
  const line = renderTabBar(state, 120, theme)[0]!;
  const glyphs = ["●", "x", "✓", "?"];
  const paints = [theme.workingFg, theme.errorFg, theme.doneFg, theme.waitingFg];
  for (let index = 0; index < statuses.length; index++) {
    const title = `Worker${index}`;
    const cells = styledCells(line);
    const start = cells
      .map((cell) => cell.char)
      .join("")
      .indexOf(title);
    assert.equal(cells[start - 2]!.char, glyphs[index]);
    assert.equal(cells[start - 2]!.fg, foregroundOf(paints[index]!));
    const titleFg = statuses[index] === "done" ? theme.doneFg : theme.muted;
    for (const cell of titleCells(line, title)) assert.equal(cell.fg, foregroundOf(titleFg));
  }
});

test("completed titles stand out until the tab is viewed", () => {
  for (const themeId of ["mixcode-dark", "light", "terminal"]) {
    for (const status of ["done", "idle"] as const) {
      const state = createInitialState("/repo");
      const theme = themeForId(themeId);
      const tab = createTab(1, "finished", "/repo", {
        title: "Finished",
        status,
        unreadDone: true,
      });
      state.tabs.push(tab, createTab(2, "other", "/repo", { title: "Other" }));
      activateTab(state, "other");
      const line = renderTabBar(state, 100, theme)[0]!;
      assert.match(stripAnsi(line), /✓ Finished/);
      for (const cell of titleCells(line, "Finished")) {
        assert.equal(cell.fg, foregroundOf(theme.doneFg), themeId);
        assert.equal(cell.bold, styledCells(theme.bold("x"))[0]!.bold, themeId);
        assert.equal(cell.dim, false, themeId);
        assert.equal(cell.inverse, false, themeId);
      }
      activateTab(state, "finished");
      activateTab(state, "other");
      const viewed = renderTabBar(state, 100, theme)[0]!;
      assert.match(stripAnsi(viewed), /- Finished/);
      for (const cell of titleCells(viewed, "Finished")) {
        assert.equal(cell.fg, foregroundOf(theme.text), themeId);
        assert.equal(cell.bold, false, themeId);
      }
    }
  }
});

test("unread completion does not override a running, waiting, or error state", () => {
  const state = createInitialState("/repo");
  const theme = themeForId("mixcode-dark");
  state.tabs = ["running", "idle", "error"].map((status, index) =>
    createTab(index + 1, `s${index}`, "/repo", {
      title: `Pending${index}`,
      status: status as "running" | "idle" | "error",
      unreadDone: true,
    }),
  );
  state.tabs[1]!.extensionUi.waitingForInputs = [{ id: "q", kind: "custom" }];
  const line = renderTabBar(state, 120, theme)[0]!;
  assert.match(stripAnsi(line), /● Pending0.*\? Pending1.*x Pending2/);
  for (const tab of state.tabs) {
    for (const cell of titleCells(line, tab.title)) {
      assert.equal(cell.fg, foregroundOf(theme.muted));
      assert.equal(cell.bold, false);
    }
  }
});

test("waiting tab keeps a colored ? without washing out the title", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  const tab = createTab(1, "s1", "/repo", { title: "Asker" });
  tab.extensionUi.waitingForInputs = [{ id: "q", kind: "custom" }];
  state.tabs.push(tab);
  activateTab(state, "s1");
  const line = renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "";
  assert.match(stripAnsi(line), /\? Asker/);
  assert.ok(
    stripAnsi(line).includes("? Asker "),
    "waiting displays the chip text after the focus mark",
  );
});

test("focused tab chip includes a left focus mark", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  state.tabs.push(createTab(1, "s1", "/repo", { title: "FocusMe" }));
  activateTab(state, "s1");
  const agentLine = stripAnsi(renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "");
  assert.match(agentLine, /▌- FocusMe/);
  activateTab(state, "home");
  const homeLine = stripAnsi(renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "");
  assert.match(homeLine, /▌MixCode Home/);
  assert.doesNotMatch(homeLine, /▌- FocusMe/);
});

test("focused working tab keeps the focus mark inside the leading pad", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  state.tabs.push(createTab(1, "s1", "/repo", { title: "FocusMe", status: "running" }));
  activateTab(state, "s1");
  const agentLine = stripAnsi(renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "");
  assert.match(agentLine, /▌● FocusMe/);
  assert.doesNotMatch(agentLine, /▌ ● FocusMe/);
});

test("Pi-derived theme maps recency paints without new Pi tokens", () => {
  const theme = themeForId("light");
  assert.equal(typeof theme.recentTab, "function");
  assert.equal(typeof theme.olderRecentTab, "function");
  assert.equal(typeof theme.activeTab, "function");
  const sample = theme.recentTab("x");
  assert.ok(sample.includes("x"));
});
