import * as assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createSyntheticSourceInfo,
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  applyModelSkillRules,
  expandEnvPath,
  formatModelSkillsHelp,
  isModelSkillsEnabled,
  isPathRef,
  loadModelSkillsConfig,
  loadSkillFromAbsolutePath,
  matchGlob,
  parseModelSkillsConfig,
  replaceSkillsInSystemPrompt,
  ruleMatches,
  setModelSkillsEnabled,
  type ModelLike,
} from "./model-skills-core.js";

/** Local fixture builder — not a product export. */
function syntheticSkill(name: string, description = `${name} skill`, filePath?: string): Skill {
  const fp = filePath ?? `/virtual/skills/${name}/SKILL.md`;
  return {
    name,
    description,
    filePath: fp,
    baseDir: path.dirname(fp),
    sourceInfo: createSyntheticSourceInfo(fp, { source: "model-skills-test" }),
    disableModelInvocation: false,
  };
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-model-skills-"));
  tmpDirs.push(d);
  return d;
}

function writeSkill(dir: string, name: string, description: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return skillDir;
}

const noVision: ModelLike = { id: "deepseek-v4-flash", provider: "deepseek", input: ["text"] };
const withVision: ModelLike = { id: "claude-sonnet", provider: "anthropic", input: ["text", "image"] };

describe("isPathRef / expandEnvPath", () => {
  test("classifies path vs name", () => {
    assert.equal(isPathRef("vision-proxy"), false);
    assert.equal(isPathRef("/abs/skill"), true);
    assert.equal(isPathRef("~/skills/x"), true);
    assert.equal(isPathRef("$HOME/skills/x"), true);
    assert.equal(isPathRef("$" + "{HOME}/skills/x"), true);
    assert.equal(isPathRef("./relative"), false);
  });

  test("expands HOME and rejects relative", () => {
    const home = expandEnvPath("$HOME/foo");
    assert.equal(home.ok, true);
    if (home.ok) assert.equal(home.path, path.join(os.homedir(), "foo"));

    const tilde = expandEnvPath("~/bar");
    assert.equal(tilde.ok, true);
    if (tilde.ok) assert.equal(tilde.path, path.join(os.homedir(), "bar"));

    const brace = expandEnvPath("$" + "{HOME}/baz");
    assert.equal(brace.ok, true);
    if (brace.ok) assert.equal(brace.path, path.join(os.homedir(), "baz"));

    const missing = expandEnvPath("$MPI_MODEL_SKILLS_NO_SUCH_VAR/x");
    assert.equal(missing.ok, false);

    const rel = expandEnvPath("$HOME/../nope-not-how-we-check");
    // Still absolute after expand — ok. Relative without abs fails:
    const pureRel = expandEnvPath("relative/path");
    // isPathRef false so expand not used for names; if forced:
    assert.equal(expandEnvPath("relative/path").ok, false);
    void rel;
  });
});

describe("matchGlob / ruleMatches", () => {
  test("model glob", () => {
    assert.equal(matchGlob("deepseek/*", "deepseek/deepseek-v4-flash"), true);
    assert.equal(matchGlob("deepseek/*", "anthropic/claude"), false);
    assert.equal(matchGlob("*/deepseek-v4-flash", "deepseek/deepseek-v4-flash"), true);
    assert.equal(matchGlob("*", "a/b"), true);
  });

  test("missingInput / hasInput", () => {
    assert.equal(ruleMatches({ missingInput: ["image"] }, noVision), true);
    assert.equal(ruleMatches({ missingInput: ["image"] }, withVision), false);
    assert.equal(ruleMatches({ hasInput: ["image"] }, withVision), true);
    assert.equal(ruleMatches({ hasInput: ["image"] }, noVision), false);
    assert.equal(ruleMatches({ model: "deepseek/*", missingInput: ["image"] }, noVision), true);
    assert.equal(ruleMatches({ model: "deepseek/*", missingInput: ["image"] }, withVision), false);
  });
});

describe("parseModelSkillsConfig / loadModelSkillsConfig", () => {
  test("valid rules", () => {
    const parsed = parseModelSkillsConfig({
      rules: [
        { match: { missingInput: ["image"] }, add: ["vision-proxy"], remove: [] },
        { match: { model: "deepseek/*" }, add: ["$HOME/skills/v"], remove: ["x"] },
      ],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.config.rules.length, 2);
      assert.equal(isModelSkillsEnabled(parsed.config), true);
    }
  });

  test("enabled false is preserved", () => {
    const parsed = parseModelSkillsConfig({ enabled: false, rules: [] });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.config.enabled, false);
      assert.equal(isModelSkillsEnabled(parsed.config), false);
    }
  });

  test("rejects bad shape", () => {
    assert.equal(parseModelSkillsConfig([]).ok, false);
    assert.equal(parseModelSkillsConfig({ rules: [{ match: "x" }] }).ok, false);
    assert.equal(parseModelSkillsConfig({ rules: [{ match: {}, add: [1] }] }).ok, false);
    assert.equal(parseModelSkillsConfig({ enabled: "yes", rules: [] }).ok, false);
  });

  test("$schema: accepted as string, rejected otherwise, preserved by setModelSkillsEnabled", () => {
    assert.equal(parseModelSkillsConfig({ $schema: 1, rules: [] }).ok, false);
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "model-skills.json"),
      JSON.stringify({ $schema: "./model-skills.schema.json", rules: [] }),
      "utf8",
    );
    const off = setModelSkillsEnabled(dir, false);
    assert.equal(off.ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "model-skills.json"), "utf8"));
    assert.equal(Object.keys(raw)[0], "$schema");
    const loaded = loadModelSkillsConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok && loaded.config) assert.equal(loaded.config.schemaRef, "./model-skills.schema.json");
  });

  test("setModelSkillsEnabled persists and preserves rules", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "model-skills.json"),
      JSON.stringify({ rules: [{ match: { model: "*" }, add: ["a"] }] }),
      "utf8",
    );
    const off = setModelSkillsEnabled(dir, false);
    assert.equal(off.ok, true);
    if (off.ok) {
      assert.equal(off.config.enabled, false);
      assert.equal(off.config.rules.length, 1);
    }
    const loaded = loadModelSkillsConfig(dir);
    assert.equal(loaded.ok && loaded.config && isModelSkillsEnabled(loaded.config), false);

    const on = setModelSkillsEnabled(dir, true);
    assert.equal(on.ok, true);
    if (on.ok) assert.equal(on.config.enabled, true);
  });

  test("load missing vs invalid vs ok", () => {
    const dir = tmpDir();
    const missing = loadModelSkillsConfig(dir);
    assert.equal(missing.ok && "missing" in missing && missing.missing, true);

    fs.writeFileSync(path.join(dir, "model-skills.json"), "{not json", "utf8");
    const bad = loadModelSkillsConfig(dir);
    assert.equal(bad.ok, false);

    fs.writeFileSync(
      path.join(dir, "model-skills.json"),
      JSON.stringify({ rules: [{ match: { model: "*" }, add: ["a"] }] }),
      "utf8",
    );
    const ok = loadModelSkillsConfig(dir);
    assert.equal(ok.ok && !("missing" in ok), true);
  });
});

describe("applyModelSkillRules", () => {
  test("add name and remove in order; same name overwrites", () => {
    const base = [syntheticSkill("a"), syntheticSkill("b"), syntheticSkill("c")];
    const pool = new Map(base.map((s) => [s.name, s]));
    const extra = syntheticSkill("vision-proxy", "Vision polyfill");
    pool.set(extra.name, extra);

    const result = applyModelSkillRules(
      [
        { match: { missingInput: ["image"] }, add: ["vision-proxy"], remove: ["b"] },
        { match: { model: "deepseek/*" }, remove: ["c"] },
      ],
      noVision,
      base,
      pool,
    );

    const names = result.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["a", "vision-proxy"]);
    assert.deepEqual(result.matchedRuleIndexes, [0, 1]);
    assert.deepEqual(result.warnings, []);
  });

  test("remove missing warns; add missing warns", () => {
    const base = [syntheticSkill("a")];
    const result = applyModelSkillRules(
      [{ match: {}, add: ["nope"], remove: ["ghost"] }],
      noVision,
      base,
      new Map(base.map((s) => [s.name, s])),
    );
    assert.deepEqual(result.skills.map((s) => s.name), ["a"]);
    assert.equal(result.warnings.some((w) => w.kind === "remove"), true);
    assert.equal(result.warnings.some((w) => w.kind === "add"), true);
  });

  test("add path loads skill from disk", () => {
    const root = tmpDir();
    const skillDir = writeSkill(root, "vision-proxy", "See images via helper model");
    const base = [syntheticSkill("keep")];
    const result = applyModelSkillRules(
      [{ match: { missingInput: ["image"] }, add: [skillDir] }],
      noVision,
      base,
      new Map(base.map((s) => [s.name, s])),
    );
    assert.deepEqual(result.skills.map((s) => s.name).sort(), ["keep", "vision-proxy"]);
    assert.deepEqual(result.warnings, []);
  });

  test("path with $HOME", () => {
    const root = tmpDir();
    const skillDir = writeSkill(root, "from-home", "From home path");
    // Point HOME at tmp parent so $HOME/... resolves into our skill.
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const loaded = loadSkillFromAbsolutePath(path.join(root, "from-home"));
      assert.equal(loaded.ok, true);

      const base = [syntheticSkill("keep")];
      const result = applyModelSkillRules(
        [{ match: { model: "*" }, add: ["$HOME/from-home"] }],
        noVision,
        base,
        new Map(),
      );
      assert.deepEqual(result.skills.map((s) => s.name).sort(), ["from-home", "keep"]);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });

  test("rules that do not match leave skills unchanged", () => {
    const base = [syntheticSkill("a")];
    const result = applyModelSkillRules(
      [{ match: { hasInput: ["image"] }, add: ["x"], remove: ["a"] }],
      noVision,
      base,
      new Map(),
    );
    assert.deepEqual(result.matchedRuleIndexes, []);
    assert.deepEqual(result.skills.map((s) => s.name), ["a"]);
  });
});

describe("formatModelSkillsHelp", () => {
  test("documents config path, match, add, and example as markdown", () => {
    const help = formatModelSkillsHelp("/tmp/agent/model-skills.json");
    assert.ok(help.includes("# /model-skills"));
    assert.ok(help.includes("/model-skills help"));
    assert.ok(help.includes("/model-skills on"));
    assert.ok(help.includes("/model-skills off"));
    assert.ok(help.includes("/tmp/agent/model-skills.json"));
    assert.ok(help.includes("missingInput"));
    assert.ok(help.includes("$HOME"));
    assert.ok(help.includes("vision-proxy"));
    assert.ok(help.includes("```json"));
  });
});

describe("replaceSkillsInSystemPrompt", () => {
  test("replaces existing skills section", () => {
    const a = syntheticSkill("a", "Skill A");
    const b = syntheticSkill("b", "Skill B");
    const originalBlock = formatSkillsForPrompt([a]);
    const prompt = `You are pi.${originalBlock}\nCurrent working directory: /tmp`;
    const next = replaceSkillsInSystemPrompt(prompt, [b]);
    assert.ok(next.includes("<name>b</name>"));
    assert.ok(!next.includes("<name>a</name>"));
    assert.ok(next.includes("Current working directory: /tmp"));
  });

  test("removes section when skills empty", () => {
    const a = syntheticSkill("a", "Skill A");
    const prompt = `Head.${formatSkillsForPrompt([a])}\nCurrent working directory: /tmp`;
    const next = replaceSkillsInSystemPrompt(prompt, []);
    assert.ok(!next.includes("available_skills"));
    assert.ok(next.includes("Current working directory: /tmp"));
  });

  test("inserts before cwd when section missing", () => {
    const a = syntheticSkill("a", "Skill A");
    const prompt = "Head.\nCurrent working directory: /tmp";
    const next = replaceSkillsInSystemPrompt(prompt, [a]);
    assert.ok(next.includes("<name>a</name>"));
    assert.ok(next.indexOf("available_skills") < next.indexOf("Current working directory"));
  });
});
