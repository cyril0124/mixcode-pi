import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  deserializeState,
  handleSubmittedInput,
  isTabColorName,
  loadStateFile,
  LOCAL_COMMANDS,
  parseInput,
  renderHome,
  renderTabBar,
  saveStateFile,
  serializeState,
  setAgentTabColor,
  TAB_COLOR_NAMES,
  tabColorPaint,
  themeForId,
  THEMES,
} from "./helpers/mixcode.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

type StyledChar = { char: string; fg: string; bg: string; bold: boolean };

/**
 * Minimal SGR walker: replays an ANSI string and reports the foreground,
 * background, and bold state in effect for every printable character. Used to
 * prove a colored chip neither changes nor leaks into neighboring styling.
 */
function styledChars(text: string): StyledChar[] {
  const out: StyledChar[] = [];
  let fg = "default";
  let bg = "default";
  let bold = false;
  const sgr = /\x1b\[([0-9;]*)([A-Za-z])/y;
  let index = 0;
  while (index < text.length) {
    sgr.lastIndex = index;
    const match = sgr.exec(text);
    if (match) {
      if (match[2] === "m") {
        const params = match[1]!.split(";");
        for (let p = 0; p < params.length; p++) {
          const code = Number(params[p] || "0");
          if (code === 0) {
            fg = "default";
            bg = "default";
            bold = false;
          } else if (code === 1) bold = true;
          else if (code === 22) bold = false;
          else if (code === 39) fg = "default";
          else if (code === 49) bg = "default";
          else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
          else if (code === 38 || code === 48) {
            const extended =
              Number(params[p + 1] ?? "5") === 2
                ? `2;${params.slice(p + 2, p + 5).join(";")}`
                : `5;${params[p + 2] ?? "0"}`;
            if (code === 38) fg = extended;
            else bg = extended;
            p += extended.startsWith("2;") ? 4 : 2;
          }
        }
      }
      index = sgr.lastIndex;
      continue;
    }
    out.push({ char: text[index]!, fg, bg, bold });
    index += 1;
  }
  return out;
}

/** Indices whose visual attributes differ; text must be identical. */
function styledDiff(withColor: string[], plain: string[]): number[] {
  const a = styledChars(withColor.join("\n"));
  const b = styledChars(plain.join("\n"));
  assert.equal(a.length, b.length, "colored render changed the character count");
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.char, b[i]!.char, `text differs at ${i}`);
    if (a[i]!.fg !== b[i]!.fg || a[i]!.bg !== b[i]!.bg || a[i]!.bold !== b[i]!.bold) diff.push(i);
  }
  return diff;
}

function commandRuntime(overrides: Record<string, unknown> = {}) {
  return {
    getTab: () => undefined,
    createTab: async () => undefined,
    renameSession: () => undefined,
    forkSession: async () => undefined,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: unknown) => base,
    ...overrides,
  } as unknown as MixCodeRuntime;
}

test("/color parses as a local command with its argument", () => {
  assert.deepEqual(parseInput("/color red"), {
    kind: "local-command",
    command: "color",
    args: "red",
  });
  assert.deepEqual(parseInput("/color"), { kind: "local-command", command: "color", args: "" });
  // Unknown colors are still routed to the handler so it can report the error.
  assert.deepEqual(parseInput("/color chartreuse"), {
    kind: "local-command",
    command: "color",
    args: "chartreuse",
  });
});

test("only palette names pass tab color validation", () => {
  for (const name of TAB_COLOR_NAMES) assert.equal(isTabColorName(name), true);
  assert.equal(isTabColorName("chartreuse"), false);
  assert.equal(isTabColorName(undefined), false);
  assert.equal(isTabColorName(41), false);
});

test("setAgentTabColor sets, clears, and rejects an unknown tab", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  setAgentTabColor(state, "s1", "blue");
  assert.equal(state.tabs[0]?.color, "blue");
  setAgentTabColor(state, "s1", undefined);
  assert.equal(state.tabs[0]?.color, undefined);
  assert.throws(() => setAgentTabColor(state, "missing", "red"), /Unknown tab: missing/);
});

test("only colored tabs are serialized, and the color survives a round trip", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  setAgentTabColor(state, "s1", "red");

  const serialized = serializeState(state);
  assert.deepEqual(serialized.tab_colors, { s1: "red" });

  const restored = deserializeState(serialized, "/repo");
  assert.equal(restored.tabs[0]?.color, "red");
  assert.equal(restored.tabs[1]?.color, undefined);
});

test("an unknown stored color name is dropped instead of failing startup", () => {
  const restored = deserializeState(
    { children: ["s1"], tab_colors: { s1: "chartreuse" } },
    "/repo",
  );
  assert.equal(restored.tabs[0]?.color, undefined);
});

test("tabColorPaint opens the color pair and keeps it across inner resets", () => {
  const painted = tabColorPaint("red")(" x \x1b[39m y \x1b[0m z ");
  assert.ok(painted.startsWith("\x1b[41m\x1b[97m"), painted);
  assert.ok(painted.endsWith("\x1b[39m\x1b[49m"), painted);
  // Inner foreground and attribute resets must not strip the chip.
  assert.ok(painted.includes("\x1b[39m\x1b[41m\x1b[97m"), painted);
  assert.ok(painted.includes("\x1b[0m\x1b[41m\x1b[97m"), painted);
});

test("the color command completes the palette plus clear", () => {
  const command = LOCAL_COMMANDS.find((item) => item.name === "color");
  assert.ok(command, "color command is registered");
  const values = command.getArgumentCompletions?.("")?.map((item) => item.value);
  assert.deepEqual(values, [...TAB_COLOR_NAMES, "clear"]);
  assert.deepEqual(
    command.getArgumentCompletions?.("gr")?.map((item) => item.value),
    ["green", "gray"],
  );
  assert.deepEqual(
    command.getArgumentCompletions?.("cl")?.map((item) => item.value),
    ["clear"],
  );
});

test("a tab color survives a real state file write and reload", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-tab-color-"));
  const file = path.join(dir, "mixcode_state.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    setAgentTabColor(state, "s1", "cyan");
    await saveStateFile(file, state);

    const reloaded = await loadStateFile(file, "/fallback");
    assert.equal(reloaded.tabs[0]?.color, "cyan");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("a colored tab renders the color as its chip background", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker", color: "red" }));
  state.activeTabId = "s1";

  const rendered = renderTabBar(state, 80, themeForId("terminal")).join("\n");
  assert.ok(rendered.includes("\x1b[41m\x1b[97m"), rendered);
  assert.match(stripAnsi(rendered), /Worker/);
});

test("a colored done tab keeps the theme's bold success color over its own background", () => {
  for (const { id } of THEMES) {
    const theme = themeForId(id);
    const build = (color: "red" | undefined) => {
      const state = createInitialState("/repo");
      state.tabs.push(
        createTab(1, "s1", "/repo", {
          title: "Worker",
          status: "done",
          unreadDone: true,
          ...(color ? { color } : {}),
        }),
      );
      state.activeTabId = "home";
      return renderTabBar(state, 60, theme).join("\n");
    };

    const plain = styledChars(build(undefined));
    const colored = styledChars(build("red"));
    const plainText = plain.map((entry) => entry.char).join("");
    const coloredText = colored.map((entry) => entry.char).join("");
    assert.equal(coloredText, plainText, `${id}: done text changed`);

    const start = coloredText.indexOf("Worker");
    assert.ok(start > 0, `${id}: title missing`);
    assert.notEqual(plain[start]!.fg, "default", `${id}: baseline has no success color`);
    for (let i = start; i < start + "Worker".length; i++) {
      assert.equal(colored[i]!.bg, "41", `${id}: background at ${i}`);
      assert.equal(colored[i]!.fg, plain[i]!.fg, `${id}: success foreground at ${i}`);
      assert.equal(colored[i]!.bold, true, `${id}: bold at ${i}`);
    }
  }
});

test("a colored tab without done uses the color's contrast foreground, not the status color", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Worker", status: "running", color: "red" }),
  );
  state.activeTabId = "home";

  const chars = styledChars(renderTabBar(state, 60, themeForId("terminal")).join("\n"));
  const text = chars.map((entry) => entry.char).join("");
  const start = text.indexOf("Worker");
  for (let i = start; i < start + "Worker".length; i++) {
    assert.equal(chars[i]!.bg, "41", `bg at ${i}`);
    assert.equal(chars[i]!.fg, "97", `fg at ${i}`);
  }
  assert.match(text, /●/);
});

test("a colored active tab keeps the focus mark and never exceeds the bar width", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker", color: "cyan" }));
  state.activeTabId = "s1";

  const lines = renderTabBar(state, 40, themeForId("terminal"));
  const rendered = lines.join("\n");
  assert.match(stripAnsi(rendered), /▌/);
  assert.ok(rendered.includes("\x1b[46m\x1b[30m"), rendered);
  for (const line of lines)
    assert.ok(visibleWidth(line) <= 40, `row too wide: ${visibleWidth(line)}`);
});

test("/color sets, persists, clears, and rejects an unknown name", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const system: string[] = [];
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };
  const runtime = commandRuntime({
    appendSystemMessage: (_sessionId: string, text: string) => {
      system.push(text);
    },
  });

  let saved: Record<string, unknown> | undefined;
  await handleSubmittedInput(state, runtime, "/color red", tui, (next) => {
    saved = serializeState(next);
  });
  assert.equal(tab.color, "red");
  assert.deepEqual(saved?.tab_colors, { s1: "red" });

  await handleSubmittedInput(state, runtime, "/color", tui);
  assert.equal(tab.color, undefined);

  await handleSubmittedInput(state, runtime, "/color chartreuse", tui);
  assert.equal(tab.color, undefined);
  assert.deepEqual(system, [
    "Error: Unknown color: chartreuse (valid: red, green, yellow, blue, magenta, cyan, white, gray, clear)",
  ]);
});

test("/color clear removes a color set earlier", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { color: "magenta" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, commandRuntime(), "/color clear", tui);
  assert.equal(tab.color, undefined);
});

test("/clear drops the tab color along with the replaced session", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { color: "red" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = {
    clearTab: async () => {
      tab.sessionId = "cleared";
      return { tab };
    },
    clearTabChatProjection: () => undefined,
    rebuildChatFromSession: () => undefined,
    getTab: () => ({
      chat: [],
      agentSession: { isStreaming: false, isBashRunning: false },
      session: { getBranch: () => [] },
    }),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

  await handleSubmittedInput(state, runtime, "/clear", tui);
  // completeAgentTabClear is deferred until after the cleared frame is painted.
  await Bun.sleep(80);
  assert.equal(tab.sessionId, "cleared");
  assert.equal(tab.color, undefined);
});

test("a colored chip changes no other tab styling, across every built-in theme", () => {
  for (const { id } of THEMES) {
    const theme = themeForId(id);
    const build = (color: "red" | undefined) => {
      const state = createInitialState("/repo");
      state.tabs.push(
        createTab(1, "s1", "/repo", { title: "First" }),
        createTab(2, "s2", "/repo", { title: "Colored", ...(color ? { color } : {}) }),
        createTab(3, "s3", "/repo", { title: "Third", status: "done" }),
      );
      // No active tab keeps the shimmer out, so both renders stay deterministic.
      state.activeTabId = "none";
      return renderTabBar(state, 120, theme);
    };

    const colored = build("red");
    const plain = build(undefined);
    const diff = styledDiff(colored, plain);
    const text = stripAnsi(colored.join("\n"));
    const start = text.indexOf("Colored");
    assert.ok(start >= 0, `${id}: title missing`);
    const chipStart = start - 3; // leading space + status glyph + space
    const chipEnd = start + "Colored".length + 1; // trailing chip space

    assert.ok(diff.length > 0, `${id}: the color had no rendering effect`);
    for (const i of diff) {
      assert.ok(
        i >= chipStart && i < chipEnd,
        `${id}: styling changed at index ${i} (${text[i]}) outside the colored chip`,
      );
    }
  }
});

test("an active colored tab keeps the color background, contrast foreground, and bold", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Colored", color: "cyan" }));
  state.activeTabId = "s1";

  const chars = styledChars(renderTabBar(state, 60, themeForId("mixcode-dark")).join("\n"));
  const text = chars.map((entry) => entry.char).join("");
  const start = text.indexOf("Colored");
  for (let i = start; i < start + "Colored".length; i++) {
    assert.equal(chars[i]!.bg, "46", `bg at ${i}`);
    assert.equal(chars[i]!.fg, "30", `fg at ${i}`);
    assert.equal(chars[i]!.bold, true, `bold at ${i}`);
  }
  // The focus mark keeps the chip background and uses the chip foreground, not
  // the theme focus color, so it stays readable on any color.
  const mark = text.indexOf("▌");
  assert.ok(mark >= 0);
  assert.equal(chars[mark]!.bg, "46");
  assert.equal(chars[mark]!.fg, "30");
});

test("a colored Home card changes no other card styling, across every built-in theme", () => {
  for (const { id } of THEMES) {
    const theme = themeForId(id);
    const build = (color: "blue" | undefined, selectedIndex: number) => {
      const state = createInitialState("/repo");
      state.tabs.push(
        createTab(1, "s1", "/repo", { title: "First" }),
        createTab(2, "s2", "/repo", { title: "Colored", ...(color ? { color } : {}) }),
      );
      state.homeSelectedTabIndex = selectedIndex;
      return renderHome(state, 100, theme);
    };

    for (const selectedIndex of [0, 1]) {
      const colored = build("blue", selectedIndex);
      const plain = build(undefined, selectedIndex);
      const diff = styledDiff(colored, plain);
      const text = stripAnsi(colored.join("\n"));
      const start = text.indexOf("Colored");
      assert.ok(start >= 0, `${id}: card title missing`);
      const titleStart = start - 2; // status glyph + space
      assert.ok(diff.length > 0, `${id}/${selectedIndex}: the color had no rendering effect`);
      for (const i of diff) {
        assert.ok(
          i >= titleStart && i < start + "Colored".length,
          `${id}/${selectedIndex}: styling changed at index ${i} (${text[i]}) outside the colored title`,
        );
      }
    }
  }
});
