import assert from "node:assert/strict";
import { test } from "node:test";
import { MixCodeCompletionProvider } from "./helpers/mixcode.js";

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
