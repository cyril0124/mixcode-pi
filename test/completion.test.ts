import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { MixCodeCompletionProvider } from "../src/index.js";

test("completion provider suggests slash commands, skills, and files", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [
      {
        name: "review",
        path: `${homedir()}/.agents/skills/review/SKILL.md`,
        description: "Review code",
      },
      "refactor",
      "waveform-debug",
    ],
    files: ["dir with spaces/", "src/", "src/index.ts", "test/runtime-ui.test.ts"],
    commands: [
      {
        name: "inspect",
        description: "Inspect extension context",
        sourceInfo: { source: "npm:pi-subagents@0.24.0" },
      },
    ],
  });
  const signal = new AbortController().signal;
  const slash = await provider.getSuggestions(["/th"], 0, 3, { signal });
  assert.equal(slash?.prefix, "/th");
  assert.equal(slash?.items[0]?.value, "/thinking");
  assert.equal(slash?.items[0]?.label, "thinking (built-in)");
  assert.equal(slash?.items[0]?.description, "Select thinking level");
  const reloadSlash = await provider.getSuggestions(["/rel"], 0, 4, { signal });
  assert.equal(reloadSlash?.items[0]?.value, "/reload");
  assert.equal(
    reloadSlash?.items[0]?.description,
    "Reload keybindings, extensions, skills, prompts, themes, and models",
  );
  const hotkeysSlash = await provider.getSuggestions(["/hot"], 0, 4, { signal });
  assert.equal(hotkeysSlash?.items[0]?.value, "/hotkeys");
  assert.equal(hotkeysSlash?.items[0]?.description, "Show all keyboard shortcuts");
  const fuzzySlash = await provider.getSuggestions(["/md"], 0, 3, { signal });
  assert.equal(fuzzySlash?.items[0]?.value, "/mark-done");
  assert.equal(fuzzySlash?.items[0]?.label, "mark-done (built-in)");
  const extensionSlash = await provider.getSuggestions(["/ins"], 0, 4, { signal });
  assert.equal(extensionSlash?.items[0]?.value, "/inspect");
  assert.equal(extensionSlash?.items[0]?.label, "inspect (ext:pi-subagents)");
  assert.equal(extensionSlash?.items[0]?.description, "Inspect extension context");
  // `$` skill completion is owned by the skill-refs extension provider; the
  // host provider no longer answers $ tokens.
  const skill = await provider.getSuggestions(["use $rv"], 0, 7, { signal });
  assert.equal(skill, null);
  // Skills still surface as /skill: slash commands.
  const skillSlash = await provider.getSuggestions(["/skill:re"], 0, 9, { signal });
  assert.equal(skillSlash?.items[0]?.value, "/skill:review");
  assert.equal(skillSlash?.items[0]?.description, "Review code");
  const file = await provider.getSuggestions(["see @runtime"], 0, 12, { signal });
  assert.equal(file?.items[0]?.value, "@test/runtime-ui.test.ts");
  assert.equal(file?.items[0]?.description, undefined);
  const directory = await provider.getSuggestions(["see @src"], 0, 8, { signal });
  assert.equal(directory?.items[0]?.value, "@src/");
  const spacedDirectory = await provider.getSuggestions(["see @spaces"], 0, 11, { signal });
  assert.equal(spacedDirectory?.items[0]?.value, '@"dir with spaces/"');
  const quotedDirectory = await provider.getSuggestions(['see @"spaces'], 0, 12, { signal });
  assert.equal(quotedDirectory?.prefix, '@"spaces');
  assert.equal(quotedDirectory?.items[0]?.value, '@"dir with spaces/"');
  assert.equal(await provider.getSuggestions(["plain"], 0, 5, { signal }), null);
  const missingLine = await provider.getSuggestions([], 0, 0, { signal });
  assert.equal(missingLine, null);
});

test("completion provider prefers live fd file search and falls back to static list", async () => {
  const signal = new AbortController().signal;
  // fileSearch points at a non-existent fd binary, so the spawn errors and
  // yields no matches; the provider must fall back to the static file list.
  const withFd = new MixCodeCompletionProvider({
    skills: [],
    files: ["src/", "src/core/", "src/core/file.ts"],
    fileSearch: () => ({ fdPath: "mixcode-nonexistent-fd-binary", workdir: process.cwd() }),
  });
  const fallback = await withFd.getSuggestions(["@src/"], 0, 5, { signal });
  assert.equal(fallback?.items[0]?.value, "@src/core/");

  // Without fileSearch, the provider uses the static list directly.
  const staticOnly = new MixCodeCompletionProvider({
    skills: [],
    files: ["src/", "src/core/", "src/core/file.ts"],
  });
  const result = await staticOnly.getSuggestions(["@src/"], 0, 5, { signal });
  assert.equal(result?.items[0]?.value, "@src/core/");
  assert.equal(result?.items[0]?.label, "src/core/");
});

test("completion provider uses fd results with basename labels when fd is available", async (t) => {
  const { resolveFdBinary } = await import("../src/index.js");
  const fdPath = resolveFdBinary();
  if (!fdPath) {
    t.skip("fd not installed");
    return;
  }
  const signal = new AbortController().signal;
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: [],
    fileSearch: () => ({ fdPath, workdir: process.cwd() }),
  });
  // "@src/core/" expands the directory; values are full paths, labels basenames
  // (pi parity), and the description carries the full display path.
  const suggestions = await provider.getSuggestions(["@src/core/"], 0, 10, { signal });
  assert.ok(suggestions && suggestions.items.length > 0);
  const picker = suggestions.items.find((item) => item.value === "@src/core/file-picker.ts");
  assert.ok(picker, "expected fd to surface src/core/file-picker.ts");
  assert.equal(picker?.label, "file-picker.ts");
  assert.equal(picker?.description, "src/core/file-picker.ts");
});

test("completion provider compacts skill descriptions before paths are truncated", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [
      {
        name: "caveman",
        path: `${homedir()}/.agents/skills/caveman/SKILL.md`,
        description:
          "Ultra-compressed communication mode. Cuts token usage by speaking briefly while keeping accuracy. Extra text that should be truncated because it is too long for the picker.",
      },
    ],
    files: [],
  });
  const signal = new AbortController().signal;
  const skill = await provider.getSuggestions(["/skill:c"], 0, 8, { signal });

  assert.equal(skill?.items[0]?.value, "/skill:caveman");
  assert.match(
    skill?.items[0]?.description ?? "",
    /^Ultra-compressed communication mode\./,
  );
  assert.doesNotMatch(skill?.items[0]?.description ?? "", />\s*>/);
  assert.ok((skill?.items[0]?.description ?? "").length < 160);
});

test("completion provider delegates extension slash argument completions", async () => {
  const calls: string[] = [];
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: [],
    commands: [
      {
        name: "run",
        description: "Run extension command",
        getArgumentCompletions: async (prefix) => {
          calls.push(prefix);
          return prefix === "rev" ? [{ value: "reviewer", label: "reviewer" }] : null;
        },
      },
      {
        name: "chain",
        description: "Run chain",
        getArgumentCompletions: (prefix) =>
          prefix === "scout -> rev" ? [{ value: "scout -> reviewer", label: "reviewer" }] : null,
      },
    ],
  });
  const signal = new AbortController().signal;

  const commandName = await provider.getSuggestions(["/ru"], 0, 3, { signal });
  assert.equal(commandName?.items[0]?.value, "/run");
  assert.equal(commandName?.items[0]?.label, "run (ext:extension)");
  assert.equal(commandName?.items[0]?.description, "Run extension command");
  assert.deepEqual(calls, []);

  const runArgs = await provider.getSuggestions(["/run rev"], 0, 8, { signal });
  assert.equal(runArgs?.prefix, "rev");
  assert.equal(runArgs?.items[0]?.value, "reviewer");
  assert.deepEqual(calls, ["rev"]);
  assert.deepEqual(
    provider.applyCompletion(["/run rev"], 0, 8, runArgs!.items[0]!, runArgs!.prefix),
    {
      lines: ["/run reviewer"],
      cursorLine: 0,
      cursorCol: 13,
    },
  );

  const chainArgs = await provider.getSuggestions(["/chain scout -> rev"], 0, 19, { signal });
  assert.equal(chainArgs?.prefix, "scout -> rev");
  assert.equal(chainArgs?.items[0]?.value, "scout -> reviewer");
  assert.deepEqual(
    provider.applyCompletion(
      ["/chain scout -> rev"],
      0,
      19,
      chainArgs!.items[0]!,
      chainArgs!.prefix,
    ),
    {
      lines: ["/chain scout -> reviewer"],
      cursorLine: 0,
      cursorCol: 24,
    },
  );
});

test("completion provider keeps the menu open for a fully typed command name", async () => {
  // Regression: returning null on an exact command-name match closed the
  // autocomplete menu, and the base Editor never re-triggers on a trailing
  // space — so `/goal ` argument hints could never appear. Keeping the menu
  // open (pi parity) lets the space keypress transition to argument hints.
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: [],
    commands: [
      {
        name: "goal",
        description: "Set or view the goal",
        getArgumentCompletions: (prefix) =>
          /\S/.test(prefix) ? null : [{ value: "pause", label: "pause", description: "Pause" }],
      },
    ],
  });
  const signal = new AbortController().signal;

  const exact = await provider.getSuggestions(["/goal"], 0, 5, { signal });
  assert.equal(exact?.items[0]?.value, "/goal");
  const withSpace = await provider.getSuggestions(["/goal "], 0, 6, { signal });
  assert.equal(withSpace?.prefix, "");
  assert.equal(withSpace?.items[0]?.value, "pause");
});

test("completion provider reads extension commands dynamically", async () => {
  let commandName = "first";
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: [],
    commands: () => [{ name: commandName, description: "dynamic" }],
  });
  const signal = new AbortController().signal;

  assert.equal(
    (await provider.getSuggestions(["/fi"], 0, 3, { signal }))?.items[0]?.value,
    "/first",
  );
  assert.equal(
    (await provider.getSuggestions(["/fi"], 0, 3, { signal }))?.items[0]?.label,
    "first (ext:extension)",
  );
  commandName = "second";
  assert.equal(
    (await provider.getSuggestions(["/sec"], 0, 4, { signal }))?.items[0]?.value,
    "/second",
  );
});

test("completion provider reads file sources dynamically", async () => {
  let files = ["old/"];
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: () => files,
  });
  const signal = new AbortController().signal;

  assert.equal(
    (await provider.getSuggestions(["see @old"], 0, 8, { signal }))?.items[0]?.value,
    "@old/",
  );

  files = ["new/"];
  assert.equal(
    (await provider.getSuggestions(["see @new"], 0, 8, { signal }))?.items[0]?.value,
    "@new/",
  );
  assert.equal((await provider.getSuggestions(["see @old"], 0, 8, { signal }))?.items.length, 0);
});

test("completion provider formats extension slash command sources", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: [],
    commands: [
      {
        name: "scoped",
        description: "Scoped package",
        sourceInfo: { source: "npm:@scope/toolkit@1.2.3" },
      },
      {
        name: "local",
        description: "Local command",
        sourceInfo: { path: "/repo/extensions/local-tool.ts" },
      },
    ],
  });
  const signal = new AbortController().signal;

  assert.equal(
    (await provider.getSuggestions(["/sco"], 0, 4, { signal }))?.items[0]?.label,
    "scoped (ext:@scope/toolkit)",
  );
  assert.equal(
    (await provider.getSuggestions(["/loc"], 0, 4, { signal }))?.items[0]?.label,
    "local (ext:local-tool)",
  );
});

test("completion provider keeps local slash commands ahead of conflicting extension commands", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: [],
    commands: [
      {
        name: "clear",
        description: "extension clear",
        getArgumentCompletions: () => [{ value: "extension", label: "extension" }],
      },
    ],
  });
  const signal = new AbortController().signal;

  const command = await provider.getSuggestions(["/cle"], 0, 4, { signal });
  assert.equal(command?.items[0]?.value, "/clear");
  assert.equal(command?.items[0]?.label, "clear (built-in)");
  assert.doesNotMatch(command?.items[0]?.description ?? "", /extension clear/);
  assert.equal(await provider.getSuggestions(["/clear x"], 0, 8, { signal }), null);
});

test("completion provider covers command descriptions and empty argument results", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [],
    files: ['quote"file.ts'],
    commands: [
      { name: "argonly", argumentHint: "<name>" },
      {
        name: "emptyargs",
        argumentHint: "<name>",
        description: "Empty args",
        getArgumentCompletions: () => [],
      },
      { name: "notarray", description: "Bad args", getArgumentCompletions: () => null },
    ],
  });
  const signal = new AbortController().signal;

  const argOnly = await provider.getSuggestions(["/argo"], 0, 5, { signal });
  assert.equal(argOnly?.items[0]?.label, "argonly (ext:extension)");
  assert.equal(argOnly?.items[0]?.description, "<name>");

  const emptyArgs = await provider.getSuggestions(["/emptyargs value"], 0, 16, { signal });
  assert.equal(emptyArgs, null);
  const notArray = await provider.getSuggestions(["/notarray value"], 0, 15, { signal });
  assert.equal(notArray, null);

  const quotedFile = await provider.getSuggestions(['see @"quote'], 0, 11, { signal });
  assert.equal(quotedFile?.items[0]?.value, '@"quote\\"file.ts"');
});

test("completion provider applies selected item and detects file trigger", () => {
  const provider = new MixCodeCompletionProvider({ skills: [], files: [] });
  const applied = provider.applyCompletion(
    ["use $rv now"],
    0,
    7,
    { value: "$review", label: "review" },
    "$rv",
  );
  assert.deepEqual(applied, { lines: ["use $review now"], cursorLine: 0, cursorCol: 11 });
  const appliedMissingLine = provider.applyCompletion(
    [],
    0,
    0,
    { value: "/help", label: "help" },
    "",
  );
  assert.deepEqual(appliedMissingLine, { lines: ["/help"], cursorLine: 0, cursorCol: 5 });
  assert.equal(provider.shouldTriggerFileCompletion(["see @src"], 0, 8), true);
  // `$` tokens no longer trigger here; the skill-refs extension wrapper does.
  assert.equal(provider.shouldTriggerFileCompletion(["use $review"], 0, 11), false);
  assert.equal(provider.shouldTriggerFileCompletion([], 0, 0), false);
  assert.equal(provider.shouldTriggerFileCompletion(["plain"], 0, 5), false);
});

test("skill completion source refreshes when cache is stale", async () => {
  const { createActiveSkillCompletionSource } = await import("../src/ui/app.js");
  const mockSkills = [
    { name: "alpha", filePath: "/skills/alpha/SKILL.md", description: "Alpha skill" },
  ];
  const mockResourceLoader = {
    getSkills: () => ({ skills: mockSkills, diagnostics: [] }),
    reload: async () => {},
  };
  const mockState = {
    activeTabId: "tab1",
    workdir: "/tmp/test-workdir",
    tabs: [{ sessionId: "tab1", workdir: "/tmp/test-workdir" }],
  } as any;
  const mockRuntime = {
    getTab: (_id: string) => ({
      services: { resourceLoader: mockResourceLoader },
      agentSession: { isStreaming: false, isCompacting: false },
    }),
  } as any;

  const getSkills = createActiveSkillCompletionSource(mockState, mockRuntime, undefined);

  // First call: returns skills from loader, sets cache
  const first = getSkills();
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    name: "alpha",
    path: "/skills/alpha/SKILL.md",
    description: "Alpha skill",
    sourceInfo: undefined,
  });

  // Second call within TTL: returns cached (same reference)
  const second = getSkills();
  assert.equal(second, first);

  // Simulate adding a new skill to the loader after background rescan
  mockSkills.push({
    name: "beta",
    filePath: "/skills/beta/SKILL.md",
    description: "Beta skill",
  });

  // Still within TTL — should return stale cache
  const third = getSkills();
  assert.equal(third.length, 1);
});
