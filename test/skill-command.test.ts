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

test("expandSkillCommand resolves from knownSkills before filesystem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    // Create a skill file at a non-standard location (simulating extension-contributed skill)
    await mkdir(join(dir, "ext-skills", "ext-review"), { recursive: true });
    await writeFile(
      join(dir, "ext-skills", "ext-review", "SKILL.md"),
      "---\ndescription: Extension review skill\n---\n# Ext Review\n\nReview from extension.",
      "utf8",
    );
    const knownSkills = [
      {
        name: "ext-review",
        filePath: join(dir, "ext-skills", "ext-review", "SKILL.md"),
        baseDir: join(dir, "ext-skills", "ext-review"),
      },
    ];
    // This skill is NOT in standard directories, so without knownSkills it would fail
    const withoutKnown = await expandSkillCommand("/skill:ext-review", dir);
    assert.equal(withoutKnown.expanded, false);

    // With knownSkills it should resolve
    const withKnown = await expandSkillCommand("/skill:ext-review do stuff", dir, { knownSkills });
    assert.equal(withKnown.expanded, true);
    assert.equal(withKnown.skillName, "ext-review");
    assert.match(withKnown.text, /<skill name="ext-review"/);
    assert.match(withKnown.text, /Review from extension\./);
    assert.match(withKnown.text, /do stuff$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildModelPrompt resolves $SkillName from knownSkills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-cmd-"));
  try {
    // Create a skill file at a non-standard location
    await mkdir(join(dir, "ext-skills", "ext-lint"), { recursive: true });
    await writeFile(
      join(dir, "ext-skills", "ext-lint", "SKILL.md"),
      "description: Extension lint skill\n\nLint from extension.",
      "utf8",
    );
    const knownSkills = [
      {
        name: "ext-lint",
        filePath: join(dir, "ext-skills", "ext-lint", "SKILL.md"),
        baseDir: join(dir, "ext-skills", "ext-lint"),
      },
    ];
    // Without knownSkills, $ext-lint would not resolve
    const withoutKnown = await buildModelPrompt("check $ext-lint", dir);
    assert.doesNotMatch(withoutKnown, /<skill name="ext-lint"/);

    // With knownSkills, $ext-lint should resolve
    const withKnown = await buildModelPrompt("check $ext-lint", dir, { knownSkills });
    assert.match(withKnown, /ext-lint/);
    assert.match(withKnown, /Extension lint skill/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
