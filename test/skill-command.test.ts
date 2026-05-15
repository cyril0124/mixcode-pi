import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { expandSkillCommand } from "../src/core/skill-command.js";
import { buildModelPrompt } from "../src/core/prompt-build.js";
import { parseInput } from "../src/core/commands.js";

test("expandSkillCommand returns unchanged text when not a /skill: prefix", async () => {
  const result = await expandSkillCommand("hello world", "/tmp");
  assert.equal(result.expanded, false);
  assert.equal(result.text, "hello world");
});

test("expandSkillCommand returns unchanged text for unknown skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    const result = await expandSkillCommand("/skill:nonexistent", dir);
    assert.equal(result.expanded, false);
    assert.equal(result.text, "/skill:nonexistent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expandSkillCommand expands known skill into XML block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    await mkdir(join(dir, ".agents", "skills", "my-skill"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "my-skill", "SKILL.md"),
      "---\ndescription: A test skill\n---\n# My Skill\n\nDo something useful.",
      "utf8",
    );
    const result = await expandSkillCommand("/skill:my-skill", dir);
    assert.equal(result.expanded, true);
    assert.equal(result.skillName, "my-skill");
    assert.match(result.text, /<skill name="my-skill"/);
    assert.match(result.text, /Do something useful\./);
    // Frontmatter should be stripped
    assert.doesNotMatch(result.text, /description: A test skill/);
    // Should include location and base dir
    assert.match(result.text, /location="/);
    assert.match(result.text, /References are relative to/);
    assert.match(result.text, /<\/skill>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expandSkillCommand appends args after skill block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "description: Code review\n\nReview the code.",
      "utf8",
    );
    const result = await expandSkillCommand("/skill:review check src/main.ts", dir);
    assert.equal(result.expanded, true);
    assert.match(result.text, /<\/skill>\n\ncheck src\/main\.ts$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expandSkillCommand handles skill name without args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    await mkdir(join(dir, ".agents", "skills", "lint"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "lint", "SKILL.md"),
      "description: Lint code\n\nRun linting.",
      "utf8",
    );
    const result = await expandSkillCommand("/skill:lint", dir);
    assert.equal(result.expanded, true);
    assert.doesNotMatch(result.text, /<\/skill>\n\n/);
    assert.match(result.text, /<\/skill>$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildModelPrompt expands /skill: command before $skill processing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    await mkdir(join(dir, ".agents", "skills", "test-skill"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "test-skill", "SKILL.md"),
      "description: Testing skill\n\nRun tests.",
      "utf8",
    );
    const prompt = await buildModelPrompt("/skill:test-skill run all tests", dir);
    assert.match(prompt, /<skill name="test-skill"/);
    assert.match(prompt, /Run tests\./);
    assert.match(prompt, /run all tests/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildModelPrompt passes through unknown /skill: as-is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    const prompt = await buildModelPrompt("/skill:unknown do stuff", dir);
    assert.equal(prompt, "/skill:unknown do stuff");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseInput routes /skill: as prompt kind", () => {
  const result = parseInput("/skill:my-skill do something");
  assert.equal(result.kind, "prompt");
  assert.equal(result.args, "/skill:my-skill do something");
});

test("parseInput routes /skill: without args as prompt kind", () => {
  const result = parseInput("/skill:lint");
  assert.equal(result.kind, "prompt");
  assert.equal(result.args, "/skill:lint");
});

test("parseInput still routes other / commands as local-command", () => {
  const result = parseInput("/models");
  assert.equal(result.kind, "local-command");
  assert.equal(result.command, "models");
});
