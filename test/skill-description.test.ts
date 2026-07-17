import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillDescription, SkillError } from "../src/core/attachments.js";

test("frontmatter description wins over body description", () => {
  const content = `---
name: demo
description: From frontmatter.
---

description: From body.
`;
  assert.equal(parseSkillDescription(content), "From frontmatter.");
});

test("inline body description used when frontmatter has no description", () => {
  const content = `---
name: demo
---

# Demo

description: Inline body description.
`;
  assert.equal(parseSkillDescription(content), "Inline body description.");
});

test("falls back to first paragraph text when no description key", () => {
  const content = `# Title

First paragraph here.
Still same paragraph.

Second paragraph.
`;
  assert.equal(parseSkillDescription(content), "First paragraph here. Still same paragraph.");
});

test("first paragraph fallback truncates to 300 characters", () => {
  const long = "x".repeat(350);
  const content = `# Title

${long}
`;
  const result = parseSkillDescription(content);
  assert.equal(result.length, 300);
  assert.equal(result, "x".repeat(300));
});

test("throws SkillError when completely empty", () => {
  assert.throws(() => parseSkillDescription(""), (error: unknown) => {
    assert.ok(error instanceof SkillError);
    assert.equal(error.message, "Skill is missing a description");
    return true;
  });
});

test("throws SkillError when no usable description", () => {
  const content = `---
name: empty
---

# Only a title
`;
  assert.throws(() => parseSkillDescription(content), (error: unknown) => {
    assert.ok(error instanceof SkillError);
    assert.equal(error.message, "Skill is missing a description");
    return true;
  });
});
