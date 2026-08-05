import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
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
  syntheticSkill,
  type ModelLike,
} from "./model-skills-core.js";

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
    expect(isPathRef("vision-proxy")).toBe(false);
    expect(isPathRef("/abs/skill")).toBe(true);
    expect(isPathRef("~/skills/x")).toBe(true);
    expect(isPathRef("$HOME/skills/x")).toBe(true);
    expect(isPathRef("${HOME}/skills/x")).toBe(true);
    expect(isPathRef("./relative")).toBe(false);
  });

  test("expands HOME and rejects relative", () => {
    const home = expandEnvPath("$HOME/foo");
    expect(home.ok).toBe(true);
    if (home.ok) expect(home.path).toBe(path.join(os.homedir(), "foo"));

    const tilde = expandEnvPath("~/bar");
    expect(tilde.ok).toBe(true);
    if (tilde.ok) expect(tilde.path).toBe(path.join(os.homedir(), "bar"));

    const brace = expandEnvPath("${HOME}/baz");
    expect(brace.ok).toBe(true);
    if (brace.ok) expect(brace.path).toBe(path.join(os.homedir(), "baz"));

    const missing = expandEnvPath("$MPI_MODEL_SKILLS_NO_SUCH_VAR/x");
    expect(missing.ok).toBe(false);

    const rel = expandEnvPath("$HOME/../nope-not-how-we-check");
    // Still absolute after expand — ok. Relative without abs fails:
    const pureRel = expandEnvPath("relative/path");
    // isPathRef false so expand not used for names; if forced:
    expect(expandEnvPath("relative/path").ok).toBe(false);
    void rel;
  });
});

describe("matchGlob / ruleMatches", () => {
  test("model glob", () => {
    expect(matchGlob("deepseek/*", "deepseek/deepseek-v4-flash")).toBe(true);
    expect(matchGlob("deepseek/*", "anthropic/claude")).toBe(false);
    expect(matchGlob("*/deepseek-v4-flash", "deepseek/deepseek-v4-flash")).toBe(true);
    expect(matchGlob("*", "a/b")).toBe(true);
  });

  test("missingInput / hasInput", () => {
    expect(ruleMatches({ missingInput: ["image"] }, noVision)).toBe(true);
    expect(ruleMatches({ missingInput: ["image"] }, withVision)).toBe(false);
    expect(ruleMatches({ hasInput: ["image"] }, withVision)).toBe(true);
    expect(ruleMatches({ hasInput: ["image"] }, noVision)).toBe(false);
    expect(ruleMatches({ model: "deepseek/*", missingInput: ["image"] }, noVision)).toBe(true);
    expect(ruleMatches({ model: "deepseek/*", missingInput: ["image"] }, withVision)).toBe(false);
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
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.rules).toHaveLength(2);
      expect(isModelSkillsEnabled(parsed.config)).toBe(true);
    }
  });

  test("enabled false is preserved", () => {
    const parsed = parseModelSkillsConfig({ enabled: false, rules: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.enabled).toBe(false);
      expect(isModelSkillsEnabled(parsed.config)).toBe(false);
    }
  });

  test("rejects bad shape", () => {
    expect(parseModelSkillsConfig([]).ok).toBe(false);
    expect(parseModelSkillsConfig({ rules: [{ match: "x" }] }).ok).toBe(false);
    expect(parseModelSkillsConfig({ rules: [{ match: {}, add: [1] }] }).ok).toBe(false);
    expect(parseModelSkillsConfig({ enabled: "yes", rules: [] }).ok).toBe(false);
  });

  test("setModelSkillsEnabled persists and preserves rules", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "model-skills.json"),
      JSON.stringify({ rules: [{ match: { model: "*" }, add: ["a"] }] }),
      "utf8",
    );
    const off = setModelSkillsEnabled(dir, false);
    expect(off.ok).toBe(true);
    if (off.ok) {
      expect(off.config.enabled).toBe(false);
      expect(off.config.rules).toHaveLength(1);
    }
    const loaded = loadModelSkillsConfig(dir);
    expect(loaded.ok && loaded.config && isModelSkillsEnabled(loaded.config)).toBe(false);

    const on = setModelSkillsEnabled(dir, true);
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.config.enabled).toBe(true);
  });

  test("load missing vs invalid vs ok", () => {
    const dir = tmpDir();
    const missing = loadModelSkillsConfig(dir);
    expect(missing.ok && "missing" in missing && missing.missing).toBe(true);

    fs.writeFileSync(path.join(dir, "model-skills.json"), "{not json", "utf8");
    const bad = loadModelSkillsConfig(dir);
    expect(bad.ok).toBe(false);

    fs.writeFileSync(
      path.join(dir, "model-skills.json"),
      JSON.stringify({ rules: [{ match: { model: "*" }, add: ["a"] }] }),
      "utf8",
    );
    const ok = loadModelSkillsConfig(dir);
    expect(ok.ok && !("missing" in ok)).toBe(true);
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
    expect(names).toEqual(["a", "vision-proxy"]);
    expect(result.matchedRuleIndexes).toEqual([0, 1]);
    expect(result.warnings).toEqual([]);
  });

  test("remove missing warns; add missing warns", () => {
    const base = [syntheticSkill("a")];
    const result = applyModelSkillRules(
      [{ match: {}, add: ["nope"], remove: ["ghost"] }],
      noVision,
      base,
      new Map(base.map((s) => [s.name, s])),
    );
    expect(result.skills.map((s) => s.name)).toEqual(["a"]);
    expect(result.warnings.some((w) => w.kind === "remove")).toBe(true);
    expect(result.warnings.some((w) => w.kind === "add")).toBe(true);
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
    expect(result.skills.map((s) => s.name).sort()).toEqual(["keep", "vision-proxy"]);
    expect(result.warnings).toEqual([]);
  });

  test("path with $HOME", () => {
    const root = tmpDir();
    const skillDir = writeSkill(root, "from-home", "From home path");
    // Point HOME at tmp parent so $HOME/... resolves into our skill.
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const loaded = loadSkillFromAbsolutePath(path.join(root, "from-home"));
      expect(loaded.ok).toBe(true);

      const base = [syntheticSkill("keep")];
      const result = applyModelSkillRules(
        [{ match: { model: "*" }, add: ["$HOME/from-home"] }],
        noVision,
        base,
        new Map(),
      );
      expect(result.skills.map((s) => s.name).sort()).toEqual(["from-home", "keep"]);
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
    expect(result.matchedRuleIndexes).toEqual([]);
    expect(result.skills.map((s) => s.name)).toEqual(["a"]);
  });
});

describe("formatModelSkillsHelp", () => {
  test("documents config path, match, add, and example as markdown", () => {
    const help = formatModelSkillsHelp("/tmp/agent/model-skills.json");
    expect(help).toContain("# /model-skills");
    expect(help).toContain("/model-skills help");
    expect(help).toContain("/model-skills on");
    expect(help).toContain("/model-skills off");
    expect(help).toContain("/tmp/agent/model-skills.json");
    expect(help).toContain("missingInput");
    expect(help).toContain("$HOME");
    expect(help).toContain("vision-proxy");
    expect(help).toContain("```json");
  });
});

describe("replaceSkillsInSystemPrompt", () => {
  test("replaces existing skills section", () => {
    const a = syntheticSkill("a", "Skill A");
    const b = syntheticSkill("b", "Skill B");
    const originalBlock = formatSkillsForPrompt([a]);
    const prompt = `You are pi.${originalBlock}\nCurrent working directory: /tmp`;
    const next = replaceSkillsInSystemPrompt(prompt, [b]);
    expect(next).toContain("<name>b</name>");
    expect(next).not.toContain("<name>a</name>");
    expect(next).toContain("Current working directory: /tmp");
  });

  test("removes section when skills empty", () => {
    const a = syntheticSkill("a", "Skill A");
    const prompt = `Head.${formatSkillsForPrompt([a])}\nCurrent working directory: /tmp`;
    const next = replaceSkillsInSystemPrompt(prompt, []);
    expect(next).not.toContain("available_skills");
    expect(next).toContain("Current working directory: /tmp");
  });

  test("inserts before cwd when section missing", () => {
    const a = syntheticSkill("a", "Skill A");
    const prompt = "Head.\nCurrent working directory: /tmp";
    const next = replaceSkillsInSystemPrompt(prompt, [a]);
    expect(next).toContain("<name>a</name>");
    expect(next.indexOf("available_skills")).toBeLessThan(next.indexOf("Current working directory"));
  });
});
