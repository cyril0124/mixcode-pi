import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTabs,
  type CommandInfo,
  createCommandBrowserComponent,
  filterItems,
} from "./command-browser.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function skill(name: string, description: string): CommandInfo {
  return {
    name: `skill:${name}`,
    description,
    source: "skill",
    sourceInfo: { path: "", source: "", scope: "user", origin: "top-level" },
  };
}

function ext(name: string, description: string, pkg: string): CommandInfo {
  return {
    name,
    description,
    source: "extension",
    sourceInfo: { path: "", source: pkg, scope: "user", origin: "package" },
  };
}

const COMMANDS: CommandInfo[] = [
  skill("darwin-skill", "autonomous skill optimizer"),
  skill("obsidian-markdown", "Create and edit Obsidian Flavored Markdown"),
  skill("minimal-change", "Prefer the smallest change that solves the problem"),
  skill("caveman", "Ultra-compressed communication mode"),
  ext("diff", "Show file changes", "npm:mpi-diff-tracker@0.1.0"),
  ext("dl", "Show file changes from the last turn", "npm:mpi-diff-tracker@0.1.0"),
  ext("commands", "Browse commands", "npm:mpi-command-browser@0.1.0"),
];

// Fake theme + tui for component-level tests.
const THEME = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

function makeTui() {
  let renders = 0;
  return {
    tui: { terminal: { columns: 100, rows: 40 }, requestRender: () => { renders++; } },
    getRenders: () => renders,
  };
}

// ─── buildTabs ───────────────────────────────────────────────────────────────

test("buildTabs splits commands into Extensions / Skills / Prompts", () => {
  const tabs = buildTabs(COMMANDS);
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].id, "extension");
  assert.equal(tabs[1].id, "skill");
  assert.equal(tabs[2].id, "prompt");
});

test("buildTabs strips skill: prefix from skill labels", () => {
  const tabs = buildTabs(COMMANDS);
  const skillItems = tabs[1].items.filter((i) => i.kind === "command");
  const labels = skillItems.map((i) => i.label);
  assert.ok(labels.includes("minimal-change"));
  assert.ok(!labels.some((l) => l.startsWith("skill:")));
});

test("buildTabs groups extensions by package name with header rows", () => {
  const tabs = buildTabs(COMMANDS);
  const headers = tabs[0].items.filter((i) => i.kind === "header").map((i) => i.label);
  assert.ok(headers.includes("mpi-diff-tracker"));
  assert.ok(headers.includes("mpi-command-browser"));
  assert.ok(tabs[0].items.some((i) => i.kind === "command" && i.label === "dl"));
});

// ─── filterItems ───────────────────────────────────────────────────────────────

test("filterItems with empty query returns everything", () => {
  const tabs = buildTabs(COMMANDS);
  assert.equal(filterItems(tabs[1].items, ""), tabs[1].items);
});

test("filterItems matches only the intended skill (the original bug)", () => {
  const tabs = buildTabs(COMMANDS);
  const filtered = filterItems(tabs[1].items, "minimal-change");
  const labels = filtered.filter((i) => i.kind === "command").map((i) => i.label);
  assert.deepEqual(labels, ["minimal-change"]);
});

test("filterItems matches the name only, never the description", () => {
  const tabs = buildTabs(COMMANDS);
  // "obsidian" appears only in the obsidian-markdown name; "Flavored" only in its
  // description. Name matches, description does not.
  assert.deepEqual(
    filterItems(tabs[1].items, "obsidian")
      .filter((i) => i.kind === "command")
      .map((i) => i.label),
    ["obsidian-markdown"],
  );
  assert.deepEqual(
    filterItems(tabs[1].items, "flavored").filter((i) => i.kind === "command"),
    [],
  );
});

test("command items carry a source tag derived from scope/package", () => {
  const tabs = buildTabs(COMMANDS);
  const skillItem = tabs[1].items.find((i) => i.kind === "command" && i.label === "minimal-change");
  assert.equal(skillItem?.sourceTag, "u");
  const extItem = tabs[0].items.find((i) => i.kind === "command" && i.label === "diff");
  assert.equal(extItem?.sourceTag, "u:mpi-diff-tracker");
  const dlItem = tabs[0].items.find((i) => i.kind === "command" && i.label === "dl");
  assert.equal(dlItem?.sourceTag, "u:mpi-diff-tracker");
});

test("filterItems is case-insensitive", () => {
  const tabs = buildTabs(COMMANDS);
  const filtered = filterItems(tabs[1].items, "CAVEMAN");
  const labels = filtered.filter((i) => i.kind === "command").map((i) => i.label);
  assert.deepEqual(labels, ["caveman"]);
});

test("filterItems drops empty group headers in the Extensions tab", () => {
  const tabs = buildTabs(COMMANDS);
  const filtered = filterItems(tabs[0].items, "diff");
  const headers = filtered.filter((i) => i.kind === "header").map((i) => i.label);
  const cmds = filtered.filter((i) => i.kind === "command").map((i) => i.label);
  assert.deepEqual(headers, ["mpi-diff-tracker"]);
  assert.deepEqual(cmds, ["diff"]);
});

// ─── Component key handling ──────────────────────────────────────────────────────

test("typing filters the visible list live", () => {
  const { tui } = makeTui();
  let result: string | null | undefined;
  const comp = createCommandBrowserComponent({
    tui,
    theme: THEME,
    commands: COMMANDS,
    done: (r) => { result = r; },
  });
  // Move to the Skills tab.
  comp.handleInput("\f"); // Ctrl+L
  for (const ch of "minimal") comp.handleInput(ch);

  const out = comp.render(100).join("\n");
  assert.ok(out.includes("minimal-change"), "expected the matching skill to be visible");
  assert.ok(!out.includes("darwin-skill"), "non-matching skills must be filtered out");
  assert.equal(result, undefined, "done must not fire while typing");
});

test("Enter selects the highlighted command and returns its full name", () => {
  const { tui } = makeTui();
  let result: string | null | undefined;
  const comp = createCommandBrowserComponent({
    tui,
    theme: THEME,
    commands: COMMANDS,
    done: (r) => { result = r; },
  });
  comp.handleInput("\f"); // Skills tab
  for (const ch of "minimal") comp.handleInput(ch);
  comp.handleInput("\r"); // Enter
  assert.equal(result, "skill:minimal-change");
});

test("Backspace shrinks the query and widens results", () => {
  const { tui } = makeTui();
  const comp = createCommandBrowserComponent({
    tui,
    theme: THEME,
    commands: COMMANDS,
    done: () => {},
  });
  comp.handleInput("\f"); // Skills tab
  for (const ch of "caveman") comp.handleInput(ch);
  assert.ok(comp.render(100).join("\n").includes("caveman"));
  for (let i = 0; i < 7; i++) comp.handleInput("\x7f"); // backspace x7 clears query
  const out = comp.render(100).join("\n");
  assert.ok(out.includes("darwin-skill"), "clearing the query restores all skills");
});

test("Esc clears the query first, then closes", () => {
  const { tui } = makeTui();
  let result: string | null | undefined = "untouched";
  const comp = createCommandBrowserComponent({
    tui,
    theme: THEME,
    commands: COMMANDS,
    done: (r) => { result = r; },
  });
  comp.handleInput("\f");
  for (const ch of "min") comp.handleInput(ch);
  comp.handleInput("\x1b"); // Esc -> clears query
  assert.equal(result, "untouched", "first Esc only clears the query");
  comp.handleInput("\x1b"); // Esc -> closes
  assert.equal(result, null, "second Esc closes with null");
});

test("Ctrl+L / Ctrl+H cycle tabs and reset the query", () => {
  const { tui } = makeTui();
  const comp = createCommandBrowserComponent({
    tui,
    theme: THEME,
    commands: COMMANDS,
    done: () => {},
  });
  // Start on Extensions, type a query, then switch tab — query must reset.
  for (const ch of "diff") comp.handleInput(ch);
  comp.handleInput("\f"); // -> Skills
  const out = comp.render(100).join("\n");
  assert.ok(out.includes("darwin-skill"), "switching tab resets the query so all skills show");
});
