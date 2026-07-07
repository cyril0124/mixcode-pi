import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildModelPrompt } from "../src/index.js";

test("buildModelPrompt passes $refs and @files through verbatim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-prompt-"));
  try {
    // $SkillName expansion is owned by the skill-refs extension inside Pi's
    // native prompt pipeline; the host must not expand or annotate it.
    await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "description: Review code",
      "utf8",
    );
    const userText = "Check $review @src/index.ts";
    const prompt = await buildModelPrompt(userText, dir);
    assert.equal(prompt, userText);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
