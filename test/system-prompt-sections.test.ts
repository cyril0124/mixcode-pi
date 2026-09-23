import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCurrentSystemPrompt,
  getSystemMessageText,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  buildMixCodeSystemPromptSections,
  sectionRowsFromRecord,
} from "../src/core/system-prompt.js";
import { renderSystemPromptSectionStats } from "../src/ui/components/system-prompt-stats.js";

const skill = (name: string): Skill =>
  ({
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: "/skills",
    sourceInfo: {},
    disableModelInvocation: false,
  }) as unknown as Skill;

const richOptions = {
  customPrompt: "You are a custom harness identity.",
  selectedTools: ["read", "bash", "edit", "write"],
  toolSnippets: { read: "Read files", bash: "Run commands" },
  promptGuidelines: ["Prefer rg over grep."],
  appendSystemPrompt: "APPEND-MARKER",
  cwd: "/tmp/some-cwd",
  contextFiles: [
    { path: "/home/u/.pi/agent/AGENTS.md", content: "全局规则 中文内容".repeat(20) },
    { path: "/proj/AGENTS.md", content: "project rules " + "latin ".repeat(100) },
  ],
  skills: [skill("alpha"), skill("beta")],
};

test("sections concatenate to the exact assembled prompt", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections(richOptions);
  assert.equal(sections.map((s) => s.text).join(""), prompt);
  assert.match(prompt, /APPEND-MARKER/);
  assert.match(prompt, /<project_instructions path="\/home\/u\/\.pi\/agent\/AGENTS\.md">/);
  assert.match(prompt, /<available_skills>/);
  assert.match(
    prompt,
    /\nCurrent date: \d{4}-\d{2}-\d{2}\nCurrent working directory: \/tmp\/some-cwd\n?$/,
  );
});

test("project context files get one section each, global and project distinct", () => {
  const { sections } = buildMixCodeSystemPromptSections(richOptions);
  const names = sections.map((s) => s.name);
  assert.ok(names.includes("project_context: /home/u/.pi/agent/AGENTS.md"));
  assert.ok(names.includes("project_context: /proj/AGENTS.md"));
  // open frame + close frame
  assert.equal(names.filter((n) => n === "project_context (frame)").length, 2);
});

test("appendSystemPrompt lands in its own section", () => {
  const { sections } = buildMixCodeSystemPromptSections(richOptions);
  const appendSection = sections.find((s) => s.name === "addendum");
  assert.ok(appendSection, "append section exists");
  assert.equal(appendSection.text, "\n\nAPPEND-MARKER");
});

test("skills section is gated on a file-reading tool like Pi's assembler", () => {
  const withRead = buildMixCodeSystemPromptSections({
    ...richOptions,
    selectedTools: ["read", "edit"],
  });
  assert.ok(withRead.sections.some((s) => s.name === "skills"));
  assert.match(withRead.prompt, /Use the read tool to load a skill's file/);

  const withBashOnly = buildMixCodeSystemPromptSections({
    ...richOptions,
    selectedTools: ["bash", "edit"],
  });
  assert.ok(withBashOnly.sections.some((s) => s.name === "skills"));
  assert.match(withBashOnly.prompt, /Use bash to load a skill's file/);

  const withoutFileTool = buildMixCodeSystemPromptSections({
    ...richOptions,
    selectedTools: ["edit", "write"],
  });
  assert.ok(!withoutFileTool.sections.some((s) => s.name === "skills"));
  assert.doesNotMatch(withoutFileTool.prompt, /<available_skills>/);
  assert.equal(withoutFileTool.sections.map((s) => s.text).join(""), withoutFileTool.prompt);
});

test("all-disabled skills emit no skills row and keep join equality", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections({
    ...richOptions,
    skills: [skill("hidden-1"), skill("hidden-2")].map((s) => ({
      ...s,
      disableModelInvocation: true,
    })),
  });
  // An empty group contributes nothing to the prompt, so it gets no row.
  assert.ok(!sections.some((s) => s.name === "skills"));
  assert.equal(sections.map((s) => s.text).join(""), prompt);
});

test("transcript sections replay exactly the prompt shown by the section statistics", () => {
  const { prompt, sections, transcriptSections } = buildMixCodeSystemPromptSections(richOptions);
  assert.deepEqual(Object.keys(transcriptSections), [
    "preamble",
    "tools",
    "docs",
    "addendum",
    "project_context",
    "skills",
    "extensions",
    "environment",
  ]);
  assert.equal(
    getSystemMessageText({
      role: "system",
      content: "",
      sections: transcriptSections,
      timestamp: 0,
    }),
    prompt,
  );
  assert.equal(sections.map((section) => section.text).join(""), prompt);
  assert.doesNotMatch(
    transcriptSections.preamble!,
    /Available tools|Project-specific instructions|Current date/,
  );
  assert.match(
    transcriptSections.project_context!,
    /<project_instructions path="\/proj\/AGENTS.md">/,
  );
});

test("project edits do not change unrelated transcript sections", () => {
  const before = buildMixCodeSystemPromptSections(richOptions).transcriptSections;
  const after = buildMixCodeSystemPromptSections({
    ...richOptions,
    contextFiles: [{ path: "/proj/AGENTS.md", content: "REPLACED PROJECT RULES" }],
  }).transcriptSections;
  const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
  assert.deepEqual(changed, ["project_context"]);
  assert.match(after.project_context!, /REPLACED PROJECT RULES/);
  assert.doesNotMatch(after.project_context!, /全局规则/);
});

test("empty groups reserve their positions without adding text to the prompt", () => {
  const empty = buildMixCodeSystemPromptSections({
    ...richOptions,
    skills: [],
    contextFiles: [],
    appendSystemPrompt: "",
  });
  const populated = buildMixCodeSystemPromptSections(richOptions);
  assert.equal(empty.transcriptSections.project_context, "");
  assert.equal(empty.transcriptSections.skills, "");
  assert.equal(empty.transcriptSections.addendum, "");
  // Apply only newly populated values, just as Pi updates its Map during replay.
  const updates = Object.fromEntries(
    Object.entries(populated.transcriptSections).filter(
      ([key, value]) => value !== empty.transcriptSections[key],
    ),
  );
  const messages: SystemMessage[] = [
    { role: "system", content: "", sections: empty.transcriptSections, timestamp: 0 },
    { role: "system", content: "", sections: updates, timestamp: 1 },
  ];
  assert.equal(getCurrentSystemPrompt(messages), populated.prompt);
});

test("extension section names cannot replace host transcript groups", () => {
  const { transcriptSections, prompt, sections } = buildMixCodeSystemPromptSections({
    ...richOptions,
    sections: { preamble: "EXTRA-PREAMBLE", environment: "EXTRA-ENVIRONMENT" },
  });
  assert.equal(transcriptSections.preamble, richOptions.customPrompt);
  assert.match(transcriptSections.extensions!, /<preamble>\nEXTRA-PREAMBLE\n<\/preamble>/);
  assert.match(transcriptSections.environment!, /Current working directory:/);
  assert.equal(sections.map((section) => section.text).join(""), prompt);
});

test("replayed section rows concatenate to the rendered prompt and keep per-file rows", () => {
  const { prompt, transcriptSections } = buildMixCodeSystemPromptSections({
    ...richOptions,
    sections: { "example-extension": "EXTENSION-TEXT" },
  });
  const rows = sectionRowsFromRecord(transcriptSections);
  assert.equal(rows.map((row) => row.text).join(""), prompt);
  assert.match(
    rows.find((row) => row.name === "extensions")?.text ?? "",
    /<example-extension>\nEXTENSION-TEXT\n<\/example-extension>/,
  );
  assert.ok(
    rows.some(
      (row) => row.name === "project_context (frame)" && row.text.includes("<project_context>"),
    ),
  );
  assert.ok(
    rows.some(
      (row) =>
        row.name === "project_context: /proj/AGENTS.md" && row.text.includes("project rules"),
    ),
  );
  // Rows cover the whole prompt, so the stats footer has nothing to reconcile.
  assert.doesNotMatch(
    renderSystemPromptSectionStats(rows, prompt),
    /extension override or format drift/,
  );
});

test("renderer totals 100% and skips empty sections", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections(richOptions);
  const out = renderSystemPromptSectionStats(sections, prompt);
  assert.match(out, /^\n```\n[\s\S]*\n```\n$/);
  assert.match(out, /Total\s+\d+ chars\s+~\d+ tok\s+100\.0%/);
  assert.doesNotMatch(out, /extension override or format drift/);
  // Non-empty sections all appear; the Skills placeholder above is not empty here.
  assert.match(out, /project_context: \/home\/u\/\.pi\/agent\/AGENTS\.md/);
});

test("renderer notes a mismatch when the effective prompt is an extension override", () => {
  const { sections } = buildMixCodeSystemPromptSections(richOptions);
  const out = renderSystemPromptSectionStats(sections, "entirely different override prompt");
  assert.match(out, /effective prompt differs - extension override or format drift/);
  assert.match(out, /Total\s+\d+ chars\s+~\d+ tok\s+100\.0%/);
});

test("appended per-turn override text (e.g. mode instructions) gets its own counted row", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections(richOptions);
  const block = "\n\nPONYTAIL-LIKE appended instructions 你好".repeat(3);
  const effective = `${prompt}${block}`;
  const out = renderSystemPromptSectionStats(sections, effective);
  assert.match(out, /\(extension override suffix\)/);
  assert.doesNotMatch(out, /effective prompt differs/);
  // Total counts the effective prompt, not just the base: chars exact, tokens strictly larger.
  const totalRow = /Total\s+(\d+) chars\s+~(\d+) tok\s+100\.0%/.exec(out)!;
  assert.equal(Number(totalRow[1]), effective.length);
  const baseOut = renderSystemPromptSectionStats(sections, prompt);
  const baseTok = Number(/Total\s+\d+ chars\s+~(\d+) tok/.exec(baseOut)![1]);
  assert.ok(Number(totalRow[2]) > baseTok, `total ${totalRow[2]} should exceed base ${baseTok}`);
});

test("prepended override text becomes a prefix row", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections(richOptions);
  const effective = `PREFIX BLOCK\n\n${prompt}`;
  const out = renderSystemPromptSectionStats(sections, effective);
  assert.match(out, /\(extension override prefix\)\s+14 chars/);
  assert.match(out, /Total\s+\d+ chars\s+~\d+ tok\s+100\.0%/);
});

test("CJK-heavy text estimates ~1 token per char, not chars/4", () => {
  const sections = [
    { name: "cjk", text: "中".repeat(300) },
    { name: "latin", text: "a".repeat(300) },
  ];
  const out = renderSystemPromptSectionStats(sections, sections.map((s) => s.text).join(""));
  // cjk: ~300 tok (80%), latin: ~75 tok (20%); a flat chars/4 heuristic would give 50/50.
  assert.match(out, /cjk\s+300 chars\s+~300 tok\s+80\.0%/);
  assert.match(out, /latin\s+300 chars\s+~75 tok\s+20\.0%/);
});
