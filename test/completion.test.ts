import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureTool } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeCompletionProvider,
  createInitialState,
  createMixCodeTui,
  createTab,
  type MixCodeRuntime,
} from "./helpers/mixcode.js";

const signal = new AbortController().signal;

test("completion adapter assembles local, extension, and skill commands", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [{ name: "review", description: "Review code" }],
    commands: [{ name: "inspect", description: "Inspect extension context" }],
  });

  const local = await provider.getSuggestions(["/th"], 0, 3, { signal });
  assert.equal(local?.items[0]?.value, "thinking");
  // argumentHint is rendered into the suggestion description by pi-tui.
  assert.equal(local?.items[0]?.description, "[level] — Select thinking level");

  const extension = await provider.getSuggestions(["/ins"], 0, 4, { signal });
  assert.equal(extension?.items[0]?.value, "inspect");
  assert.equal(extension?.items[0]?.description, "Inspect extension context");

  const skill = await provider.getSuggestions(["/skill:re"], 0, 9, { signal });
  assert.equal(skill?.items[0]?.value, "skill:review");
  assert.equal(skill?.items[0]?.description, "Review code");
});

test("completion adapter resolves extension commands dynamically", async () => {
  let commandName = "first";
  const provider = new MixCodeCompletionProvider({
    skills: [],
    commands: () => [{ name: commandName, description: "dynamic" }],
  });

  assert.equal(
    (await provider.getSuggestions(["/fi"], 0, 3, { signal }))?.items[0]?.value,
    "first",
  );
  commandName = "second";
  assert.equal(
    (await provider.getSuggestions(["/sec"], 0, 4, { signal }))?.items[0]?.value,
    "second",
  );
});

test("completion adapter forwards extension argument completions", async () => {
  const calls: string[] = [];
  const provider = new MixCodeCompletionProvider({
    skills: [],
    commands: [
      {
        name: "run",
        description: "Run extension command",
        getArgumentCompletions: async (prefix) => {
          calls.push(prefix);
          return prefix === "rev" ? [{ value: "reviewer", label: "reviewer" }] : null;
        },
      },
    ],
  });

  const commandName = await provider.getSuggestions(["/ru"], 0, 3, { signal });
  assert.equal(commandName?.items[0]?.value, "run");
  assert.deepEqual(calls, []);

  const args = await provider.getSuggestions(["/run rev"], 0, 8, { signal });
  assert.equal(args?.prefix, "rev");
  assert.equal(args?.items[0]?.value, "reviewer");
  assert.deepEqual(calls, ["rev"]);
});

test("completion adapter keeps local commands ahead of extension conflicts", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [],
    commands: [
      {
        name: "clear",
        description: "extension clear",
        getArgumentCompletions: () => [{ value: "extension", label: "extension" }],
      },
    ],
  });

  const command = await provider.getSuggestions(["/cle"], 0, 4, { signal });
  assert.equal(command?.items[0]?.value, "clear");
  assert.doesNotMatch(command?.items[0]?.description ?? "", /extension clear/);
  assert.equal(await provider.getSuggestions(["/clear x"], 0, 8, { signal }), null);
});

test("completion adapter compacts skill descriptions", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [
      {
        name: "caveman",
        description:
          "Ultra-compressed communication mode. Cuts token usage by speaking briefly while keeping accuracy. Extra text that should be truncated because it is too long for the picker.",
      },
    ],
  });
  const skill = await provider.getSuggestions(["/skill:c"], 0, 8, { signal });

  assert.match(skill?.items[0]?.description ?? "", /^Ultra-compressed communication mode\./);
  assert.ok((skill?.items[0]?.description ?? "").length < 160);
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
  const first = getSkills();
  assert.deepEqual(first, [
    {
      name: "alpha",
      path: "/skills/alpha/SKILL.md",
      description: "Alpha skill",
      sourceInfo: undefined,
    },
  ]);

  mockSkills.push({
    name: "beta",
    filePath: "/skills/beta/SKILL.md",
    description: "Beta skill",
  });
  assert.deepEqual(getSkills(), first);
});

test("@ completion lists current-instance tab mentions above file matches", async (t) => {
  const fdPath = await ensureTool("fd");
  if (!fdPath) {
    t.skip("Pi could not provide fd");
    return;
  }
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-completion-tabs-"));
  try {
    await fsPromises.writeFile(path.join(dir, "agenda.md"), "");
    const provider = new MixCodeCompletionProvider({
      skills: [],
      workdir: dir,
      fdPath,
      tabs: [
        { title: "Agent-02", status: "idle" },
        { title: "Review", status: "running" },
      ],
    });

    const result = await provider.getSuggestions(["@age"], 0, 4, { signal });
    assert.equal(result?.prefix, "@age");
    assert.equal(result?.items[0]?.value, "@Agent-02");
    assert.equal(result?.items[0]?.label, "Agent-02");
    assert.equal(result?.items[0]?.description, "[tab] idle");
    // Existing fd file completion stays available after tab mentions.
    assert.ok(result?.items.some((item) => item.value === "@agenda.md"));
    // Non-matching tab titles are filtered out.
    assert.ok(!result?.items.some((item) => item.label === "Review"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("@ completion quotes spaced tab titles and works without file matches", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-completion-tabs-empty-"));
  try {
    const provider = new MixCodeCompletionProvider({
      skills: [],
      workdir: dir,
      tabs: () => [{ title: "My Review Tab", status: "running" }],
    });

    const result = await provider.getSuggestions(["@rev"], 0, 4, { signal });
    assert.equal(result?.prefix, "@rev");
    assert.deepEqual(result?.items, [
      { value: '@"My Review Tab"', label: "My Review Tab", description: "[tab] running" },
    ]);

    const applied = provider.applyCompletion(["@rev"], 0, 4, result!.items[0]!, result!.prefix);
    assert.equal(applied.lines[0], '@"My Review Tab" ');
    assert.equal(applied.cursorCol, '@"My Review Tab" '.length);

    // No tab match and no file match keeps the upstream null contract.
    assert.equal(await provider.getSuggestions(["@zzz"], 0, 4, { signal }), null);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("@ completion applies slash-ending tab titles as mentions", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [],
    tabs: [{ title: "Review/" }, { title: "My Review/" }],
  });

  const result = await provider.getSuggestions(["@rev"], 0, 4, { signal });
  const plain = result!.items.find((item) => item.label === "Review/")!;
  const quoted = result!.items.find((item) => item.label === "My Review/")!;
  assert.deepEqual(provider.applyCompletion(["@rev"], 0, 4, plain, result!.prefix), {
    lines: ["@Review/ "],
    cursorLine: 0,
    cursorCol: "@Review/ ".length,
  });
  assert.deepEqual(provider.applyCompletion(["@rev"], 0, 4, quoted, result!.prefix), {
    lines: ['@"My Review/" '],
    cursorLine: 0,
    cursorCol: '@"My Review/" '.length,
  });
});

test("@ completion JSON-escapes quotes in tab titles", async () => {
  const provider = new MixCodeCompletionProvider({
    skills: [],
    tabs: [{ title: 'A "Review"' }],
  });

  const result = await provider.getSuggestions(["@rev"], 0, 4, { signal });
  assert.equal(result?.items[0]?.value, '@"A \\"Review\\""');
  const applied = provider.applyCompletion(["@rev"], 0, 4, result!.items[0]!, result!.prefix);
  assert.equal(applied.lines[0], '@"A \\"Review\\"" ');
  assert.equal(applied.cursorCol, '@"A \\"Review\\"" '.length);
});

test("editor @ completion offers peer tabs, not the prompt-target tab itself", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-completion-tabs-tui-"));
  const state = createInitialState(dir);
  const selfTab = createTab(1, "s1", dir, { title: "Self-Tab" });
  const peerTab = createTab(2, "s2", dir, { title: "Peer-Tab/" });
  state.tabs.push(selfTab, peerTab);
  state.activeTabId = "s1";
  const tabsById: Record<string, typeof selfTab> = { s1: selfTab, s2: peerTab };
  const runtime = {
    onChange: () => () => undefined,
    getTab: (sessionId: string) => ({ tab: tabsById[sessionId] ?? selfTab, chat: [] }),
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
  } as unknown as MixCodeRuntime;
  const terminal: Terminal = {
    columns: 120,
    rows: 40,
    write: () => undefined,
    onData: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    setRawMode: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
  const stripAnsi = (text: string) =>
    text
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[ -/]*[@-~]/g, "");
  const tui = createMixCodeTui(state, runtime, {
    terminal,
    completionSources: { skills: [] },
  });
  try {
    const layout = (
      tui as unknown as {
        children: Array<{
          editor: {
            current: Component;
            handleInput: (data: string) => void;
            getText: () => string;
            isShowingAutocomplete: () => boolean;
          };
        }>;
      }
    ).children[0]!;

    layout.editor.handleInput("@");
    for (let i = 0; i < 100 && !layout.editor.isShowingAutocomplete(); i++) {
      await Bun.sleep(10);
    }
    assert.ok(layout.editor.isShowingAutocomplete());
    const rendered = stripAnsi(layout.editor.current.render(80).join("\n"));
    assert.match(rendered, /Peer-Tab\//);
    assert.doesNotMatch(rendered, /Self-Tab/);
    layout.editor.handleInput("\r");
    assert.equal(layout.editor.getText(), "@Peer-Tab/ ");
  } finally {
    tui.stop();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
