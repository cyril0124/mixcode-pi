import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { buildMixCodeSystemPromptSections } from "../src/core/system-prompt.js";
import { renderSystemPromptSectionStats } from "../src/ui/system-prompt-stats.js";

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
  conversationHistoryPrompt: "HISTORY-MARKER",
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
  assert.match(prompt, /HISTORY-MARKER/);
  assert.match(prompt, /<project_instructions path="\/home\/u\/\.pi\/agent\/AGENTS\.md">/);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /\nCurrent date: \d{4}-\d{2}-\d{2}\nCurrent working directory: \/tmp\/some-cwd\n?$/);
});

test("project context files get one section each, global and project distinct", () => {
  const { sections } = buildMixCodeSystemPromptSections(richOptions);
  const names = sections.map((s) => s.name);
  assert.ok(names.includes("Project context: /home/u/.pi/agent/AGENTS.md"));
  assert.ok(names.includes("Project context: /proj/AGENTS.md"));
  // open frame + close frame
  assert.equal(names.filter((n) => n === "Project context (frame)").length, 2);
});

test("appendSystemPrompt and conversation history are separate sections", () => {
  const { sections } = buildMixCodeSystemPromptSections(richOptions);
  const byName = Object.fromEntries(sections.map((s) => [s.name, s]));
  assert.equal(byName["Append (appendSystemPrompt)"].text, "\n\nAPPEND-MARKER");
  assert.equal(byName["Conversation history"].text, "\n\nHISTORY-MARKER");
});

test("skills section is gated on the read tool like Pi's assembler", () => {
  const withRead = buildMixCodeSystemPromptSections({ ...richOptions, selectedTools: ["read", "edit"] });
  assert.ok(withRead.sections.some((s) => s.name === "Skills"));

  const withoutRead = buildMixCodeSystemPromptSections({
    ...richOptions,
    selectedTools: ["bash", "edit"],
  });
  assert.ok(!withoutRead.sections.some((s) => s.name === "Skills"));
  assert.doesNotMatch(withoutRead.prompt, /<available_skills>/);
  assert.equal(
    withoutRead.sections.map((s) => s.text).join(""),
    withoutRead.prompt,
  );
});

test("all-disabled skills keep join equality with an empty Skills section", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections({
    ...richOptions,
    skills: [skill("hidden-1"), skill("hidden-2")].map((s) => ({
      ...s,
      disableModelInvocation: true,
    })),
  });
  const skillsSection = sections.find((s) => s.name === "Skills");
  assert.ok(skillsSection);
  assert.equal(skillsSection.text, "");
  assert.equal(sections.map((s) => s.text).join(""), prompt);
});

test("renderer totals 100% and skips empty sections", () => {
  const { prompt, sections } = buildMixCodeSystemPromptSections(richOptions);
  const out = renderSystemPromptSectionStats(sections, prompt);
  assert.match(out, /Total\s+\d+ chars\s+~\d+ tok\s+100\.0%/);
  assert.doesNotMatch(out, /extension override or format drift/);
  // Non-empty sections all appear; the Skills placeholder above is not empty here.
  assert.match(out, /Project context: \/home\/u\/\.pi\/agent\/AGENTS\.md/);
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
