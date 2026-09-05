import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { renderHome } from "../src/ui/rendering/overlays.js";
import { themeForId } from "../src/ui/themes.js";

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

test("Home places the selected conversation beside the roster on wide screens", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "first", "/repo", { title: "First" }),
    createTab(2, "second", "/repo", { title: "Second" }),
  );
  state.homeSelectedTabIndex = 1;
  const lines = plain(
    renderHome(state, 140, undefined, 0, 32, (id) => [
      { role: "user", text: id === "second" ? "Review the parser" : "Unselected request" },
      { role: "assistant", text: id === "second" ? "Parser review complete" : "First output" },
    ]),
  );
  const heading = lines.find((line) => line.includes("Agents") && line.includes("Conversation"));
  assert.ok(heading, "roster and conversation share a heading row");
  assert.ok(heading.indexOf("Conversation") > heading.indexOf("Agents"));
  assert.match(lines.join("\n"), /user:.*Review the parser/);
  assert.match(lines.join("\n"), /assistant:.*Parser review complete/);
  assert.doesNotMatch(lines.join("\n"), /Unselected request/);
});

test("Home keeps the selected agent visible and every cell inside resized viewports", () => {
  const state = createInitialState("/repo/a-long-project-directory");
  for (let i = 0; i < 16; i++) {
    state.tabs.push(createTab(i + 1, `s${i}`, "/repo", { title: `Agent-${i}-long-title` }));
  }
  state.homeSelectedTabIndex = 15;
  for (const theme of ["mixcode-dark", "light", "terminal"]) {
    for (const [width, height] of [
      [28, 9],
      [40, 12],
      [80, 24],
      [120, 32],
      [180, 48],
    ]) {
      const lines = renderHome(state, width!, themeForId(theme), 0, height!);
      assert.equal(lines.length, height);
      assert.ok(
        lines.every((line) => visibleWidth(line) === width),
        `${theme} ${width}x${height}`,
      );
      assert.match(plain(lines).join("\n"), /Agent-15/, `${theme} ${width}x${height}`);
    }
  }
});

test("Home wraps wide conversation previews without leaking terminal controls", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const text = `Inspect the parser. ${"Preserve input validation. ".repeat(8)}Boundary verified.`;
  const lines = renderHome(state, 140, undefined, 0, 32, () => [
    { role: "assistant", text: `${text}\u001b[2J` },
  ]);
  assert.match(plain(lines).join("\n"), /Boundary verified\./);
  assert.ok(lines.every((line) => visibleWidth(line) === 140));
  assert.ok(!lines.join("\n").includes("\u001b[2J"));
});

test("Home retains the newest text when previewing a multi-megabyte response", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const text = `${"word ".repeat(850_000)}END-OF-LARGE-MESSAGE`;
  const lines = renderHome(state, 120, undefined, 0, 32, () => [{ role: "assistant", text }]);
  assert.equal(lines.length, 32);
  assert.ok(lines.every((line) => visibleWidth(line) === 120));
  assert.match(plain(lines).join("\n"), /END-OF-LARGE-MESSAGE/);
  assert.match(plain(lines).join("\n"), /earlier messages/);
});

test("Home keeps a complete consecutive tool count at the oldest visible preview boundary", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const lines = renderHome(state, 100, undefined, 0, undefined, () => [
    { role: "user", text: "Check the parser" },
    ...Array.from({ length: 50 }, () => ({ role: "tool" as const, text: "Tool result" })),
    ...Array.from({ length: 4 }, (_, index) => ({
      role: "assistant" as const,
      text: `Checks complete ${index + 1}`,
    })),
  ]);
  assert.match(plain(lines).join("\n"), /tools:.*50/);
  assert.match(plain(lines).join("\n"), /assistant: Checks complete/);
});

test("Home previews follow same-length text edits and viewport changes", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const tokens = Array.from({ length: 160 }, (_, index) => `T${String(index).padStart(3, "0")}`);
  const message = { role: "assistant" as const, text: `OLD-START ${tokens.join(" ")} OLD-END` };
  const chat = () => [message];
  const first = plain(renderHome(state, 140, undefined, 0, 24, chat)).join("\n");
  assert.match(first, /OLD-START/);
  assert.match(first, /OLD-END/);
  message.text = message.text.replaceAll("OLD", "NEW");
  const edited = plain(renderHome(state, 140, undefined, 0, 24, chat)).join("\n");
  assert.match(edited, /NEW-START/);
  assert.match(edited, /NEW-END/);
  assert.doesNotMatch(edited, /OLD-START|OLD-END/);
  for (const width of [140, 121]) {
    const lines = renderHome(state, width, undefined, 0, 48, chat);
    const text = plain(lines).join("\n");
    for (const token of tokens) assert.ok(text.includes(token), `${width}: ${token}`);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
});

test("Home shows no stale conversation when the non-idle roster is empty", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { status: "idle", title: "Idle" }));
  state.homeNonIdleOnly = true;
  const lines = plain(
    renderHome(state, 140, undefined, 0, 32, () => [
      { role: "assistant", text: "Hidden conversation" },
    ]),
  );
  assert.match(lines.join("\n"), /No non-idle agents/);
  assert.doesNotMatch(lines.join("\n"), /Hidden conversation/);
});

test("Home preserves the agent identifier beside a loading phase in a 20-column terminal", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s15", "/repo", { title: "Agent-15", status: "Not Ready" });
  tab.loadingPhase = "resources";
  state.tabs.push(tab);
  const lines = renderHome(state, 20, undefined, 0, 12);
  const row = plain(lines).find((line) => line.includes("›"));
  assert.ok(row);
  assert.match(row, /Agent-15/);
  assert.match(row, /\[re/);
  assert.ok(lines.every((line) => visibleWidth(line) === 20));
});

test("Home keeps the selected agent when only one to three content rows remain", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Selected" }));
  for (const height of [1, 2, 3]) {
    const lines = renderHome(state, 40, undefined, 0, height);
    assert.equal(lines.length, height);
    assert.match(plain(lines).join("\n"), /Selected/);
  }
});
