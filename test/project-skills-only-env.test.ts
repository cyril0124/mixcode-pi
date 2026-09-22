import { isolatedAgentDir } from "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isProjectSkillsOnlyEnabled, scanSkillEntries } from "../src/core/attachments.js";

describe("MIXCODE_PROJECT_SKILLS_ONLY environment variable", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let workdir: string;
  let homeDir: string;

  beforeEach(async () => {
    delete process.env.MIXCODE_PROJECT_SKILLS_ONLY;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-skills-test-"));
    workdir = path.join(tmpDir, "workdir");
    homeDir = path.join(tmpDir, "home");

    await fs.mkdir(path.join(workdir, ".agents", "skills", "local-skill"), { recursive: true });
    await fs.writeFile(
      path.join(workdir, ".agents", "skills", "local-skill", "SKILL.md"),
      "---\nname: local-skill\ndescription: Local skill\n---\nLocal content",
    );

    await fs.mkdir(path.join(homeDir, ".agents", "skills", "global-skill"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".agents", "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: Global skill\n---\nGlobal content",
    );

    await fs.mkdir(path.join(isolatedAgentDir, "skills", "agent-skill"), { recursive: true });
    await fs.writeFile(
      path.join(isolatedAgentDir, "skills", "agent-skill", "SKILL.md"),
      "---\nname: agent-skill\ndescription: Agent dir skill\n---\nAgent content",
    );
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("isProjectSkillsOnlyEnabled correctly parses truthy values", () => {
    for (const val of ["1", "true", "TRUE", "on", "ON", "yes", "YES"]) {
      process.env.MIXCODE_PROJECT_SKILLS_ONLY = val;
      assert.equal(isProjectSkillsOnlyEnabled(), true);
    }
  });

  it("scans only the workdir skills directory when enabled", async () => {
    process.env.MIXCODE_PROJECT_SKILLS_ONLY = "1";
    const names = (await scanSkillEntries(workdir, homeDir)).map((skill) => skill.name);
    assert.equal(names.includes("local-skill"), true);
    assert.equal(names.includes("global-skill"), false);
    assert.equal(names.includes("agent-skill"), false);
  });

  it("scans workdir, home, and agent-dir skills when disabled", async () => {
    const names = (await scanSkillEntries(workdir, homeDir)).map((skill) => skill.name);
    assert.equal(names.includes("local-skill"), true);
    assert.equal(names.includes("global-skill"), true);
    assert.equal(names.includes("agent-skill"), true);
  });
});
