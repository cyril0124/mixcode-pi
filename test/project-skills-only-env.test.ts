import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isProjectSkillsOnlyEnabled, resolveSkillDirs, scanSkillEntries } from "../src/core/attachments.js";

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

  it("resolves all directories when disabled", () => {
    const dirs = resolveSkillDirs(workdir, homeDir);
    assert.equal(dirs.length >= 2, true);
    assert.equal(dirs.some((d) => d.includes(path.join(workdir, ".agents", "skills"))), true);
    assert.equal(dirs.some((d) => d.includes(path.join(homeDir, ".agents", "skills"))), true);
  });

  it("resolves only workdir directory when enabled", () => {
    process.env.MIXCODE_PROJECT_SKILLS_ONLY = "1";
    const dirs = resolveSkillDirs(workdir, homeDir);
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0], path.resolve(workdir, ".agents", "skills"));
  });

  it("scans only local skills when enabled", async () => {
    process.env.MIXCODE_PROJECT_SKILLS_ONLY = "1";
    const skills = await scanSkillEntries(workdir, homeDir);
    const names = skills.map((s) => s.name);
    assert.equal(names.includes("local-skill"), true);
    assert.equal(names.includes("global-skill"), false);
  });

  it("scans both local and global skills when disabled", async () => {
    const skills = await scanSkillEntries(workdir, homeDir);
    const names = skills.map((s) => s.name);
    assert.equal(names.includes("local-skill"), true);
    assert.equal(names.includes("global-skill"), true);
  });
});
