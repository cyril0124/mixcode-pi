import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildModelPrompt } from "../src/index.js";

test("buildModelPrompt combines user text, skills, and file refs without workdir instructions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-prompt-"));
  try {
    await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "description: Review code",
      "utf8",
    );
    await writeFile(join(dir, "AGENTS.md"), "Use tests", "utf8");
    const userText = "Check $review @src/index.ts";
    const prompt = await buildModelPrompt(userText, dir);
    assert.equal(prompt.startsWith(`${userText}\n\n`), true);
    assert.match(prompt, /<skill name=/);
    assert.doesNotMatch(prompt, /<files>/);
    assert.doesNotMatch(prompt, /workdir-instructions|Project Context|Use tests/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
