import * as assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSyntheticSourceInfo,
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  applyModelSkillRules,
  expandEnvPath,
  formatModelAttachHelp,
  friendlyExtensionName,
  isPathRef,
  isSectionEnabled,
  loadModelAttachConfig,
  loadSkillFromAbsolutePath,
  matchGlob,
  modelKey,
  parseModelAttachConfig,
  planModelExtensionLoads,
  replaceSkillsInSystemPrompt,
  resolveExtensionEntry,
  resolveExtensionName,
  resolveExtensionRef,
  ruleMatches,
  setSectionEnabled,
  type ModelLike,
} from "./model-attach-core.js";
import { createDynamicExtensionLoader } from "./model-attach-loader.js";

function syntheticSkill(name: string, description = `${name} skill`, filePath?: string): Skill {
  const fp = filePath ?? `/virtual/skills/${name}/SKILL.md`;
  return {
    name,
    description,
    filePath: fp,
    baseDir: path.dirname(fp),
    sourceInfo: createSyntheticSourceInfo(fp, { source: "model-attach-test" }),
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-model-attach-"));
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

function writeExt(dir: string, name: string, toolName = name.replace(/-/g, "_")): string {
  const extDir = path.join(dir, name);
  fs.mkdirSync(extDir, { recursive: true });
  const file = path.join(extDir, "index.ts");
  fs.writeFileSync(
    file,
    `export default function (pi: { registerTool: (t: { name: string }) => void }) {\n` +
      `  pi.registerTool({ name: ${JSON.stringify(toolName)} });\n` +
      `}\n`,
    "utf8",
  );
  return file;
}

const noVision: ModelLike = { id: "deepseek-v4-flash", provider: "deepseek", input: ["text"] };
const withVision: ModelLike = {
  id: "claude-sonnet",
  provider: "anthropic",
  input: ["text", "image"],
};

describe("isPathRef / expandEnvPath", () => {
  test("classifies path vs name", () => {
    assert.equal(isPathRef("vision-proxy"), false);
    assert.equal(isPathRef("/abs/skill"), true);
    assert.equal(isPathRef("~/skills/x"), true);
    assert.equal(isPathRef("$HOME/skills/x"), true);
    assert.equal(isPathRef("$" + "{HOME}/skills/x"), true);
    assert.equal(isPathRef("./relative"), false);
  });

  test("expands HOME and rejects unknown env / relative", () => {
    const home = expandEnvPath("$HOME/foo");
    assert.equal(home.ok, true);
    if (home.ok) assert.equal(home.path, path.join(os.homedir(), "foo"));

    const tilde = expandEnvPath("~/bar");
    assert.equal(tilde.ok, true);
    if (tilde.ok) assert.equal(tilde.path, path.join(os.homedir(), "bar"));

    const brace = expandEnvPath("$" + "{HOME}/baz");
    assert.equal(brace.ok, true);
    if (brace.ok) assert.equal(brace.path, path.join(os.homedir(), "baz"));

    const missing = expandEnvPath("$MPI_MODEL_ATTACH_NO_SUCH_VAR/x");
    assert.equal(missing.ok, false);

    assert.equal(expandEnvPath("relative/path").ok, false);
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

describe("parseModelAttachConfig / load / setSectionEnabled", () => {
  test("parses combined skills + extensions", () => {
    const parsed = parseModelAttachConfig({
      skills: {
        rules: [{ match: { missingInput: ["image"] }, add: ["vision-proxy"], remove: [] }],
      },
      extensions: {
        enabled: true,
        rules: [{ match: { model: "deepseek/*" }, add: ["vision-helper"], remove: ["x"] }],
      },
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.config.skills?.rules.length, 1);
      assert.equal(isSectionEnabled(parsed.config.skills), true);
      assert.equal(parsed.config.extensions?.rules.length, 1);
      assert.equal(isSectionEnabled(parsed.config.extensions), true);
    }
  });

  test("omitted section is valid; empty root is valid", () => {
    const skillsOnly = parseModelAttachConfig({
      skills: { rules: [{ match: {}, add: ["a"] }] },
    });
    assert.equal(skillsOnly.ok, true);
    if (skillsOnly.ok) {
      assert.equal(skillsOnly.config.extensions, undefined);
      assert.equal(isSectionEnabled(skillsOnly.config.extensions), true);
    }

    const empty = parseModelAttachConfig({});
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.equal(empty.config.skills, undefined);
      assert.equal(empty.config.extensions, undefined);
    }
  });

  test("section enabled false is preserved", () => {
    const parsed = parseModelAttachConfig({
      skills: { enabled: false, rules: [] },
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.config.skills?.enabled, false);
      assert.equal(isSectionEnabled(parsed.config.skills), false);
    }
  });

  test("rejects old root rules/enabled and bad shapes", () => {
    assert.equal(parseModelAttachConfig([]).ok, false);
    assert.equal(parseModelAttachConfig({ rules: [] }).ok, false);
    assert.equal(parseModelAttachConfig({ enabled: true }).ok, false);
    assert.equal(parseModelAttachConfig({ skills: { rules: [{ match: "x" }] } }).ok, false);
    assert.equal(
      parseModelAttachConfig({ extensions: { rules: [{ match: {}, add: [1] }] } }).ok,
      false,
    );
    assert.equal(parseModelAttachConfig({ skills: { enabled: "yes", rules: [] } }).ok, false);
    assert.equal(parseModelAttachConfig({ foo: 1 }).ok, false);
    assert.equal(
      parseModelAttachConfig({ skills: { rules: [{ match: { provider: "deepseek" } }] } }).ok,
      false,
    );
  });

  test("$schema: accepted as string, rejected otherwise, preserved by setSectionEnabled", () => {
    assert.equal(parseModelAttachConfig({ $schema: 1 }).ok, false);
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "mpi-model-attach.json"),
      JSON.stringify({
        $schema: "./mpi-model-attach.schema.json",
        skills: { rules: [] },
      }),
      "utf8",
    );
    const off = setSectionEnabled(dir, "skills", false);
    assert.equal(off.ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "mpi-model-attach.json"), "utf8"));
    assert.equal(Object.keys(raw)[0], "$schema");
    const loaded = loadModelAttachConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok && loaded.config)
      assert.equal(loaded.config.schemaRef, "./mpi-model-attach.schema.json");
  });

  test("setSectionEnabled persists one section without clobbering the other", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "mpi-model-attach.json"),
      JSON.stringify({
        skills: { rules: [{ match: { model: "*" }, add: ["a"] }] },
        extensions: { rules: [{ match: { model: "a/*" }, add: ["x"] }] },
      }),
      "utf8",
    );
    const off = setSectionEnabled(dir, "skills", false);
    assert.equal(off.ok, true);
    if (off.ok) {
      assert.equal(off.config.skills?.enabled, false);
      assert.equal(off.config.skills?.rules.length, 1);
      assert.equal(off.config.extensions?.rules.length, 1);
      assert.equal(off.config.extensions?.enabled, undefined);
    }

    const loaded = loadModelAttachConfig(dir);
    assert.equal(loaded.ok && loaded.config && isSectionEnabled(loaded.config.skills), false);
    assert.equal(loaded.ok && loaded.config && isSectionEnabled(loaded.config.extensions), true);

    const extOff = setSectionEnabled(dir, "extensions", false);
    assert.equal(extOff.ok, true);
    if (extOff.ok) {
      assert.equal(extOff.config.skills?.enabled, false);
      assert.equal(extOff.config.extensions?.enabled, false);
    }
  });

  test("load missing vs invalid vs ok", () => {
    const dir = tmpDir();
    const missing = loadModelAttachConfig(dir);
    assert.equal(missing.ok && "missing" in missing && missing.missing, true);

    fs.writeFileSync(path.join(dir, "mpi-model-attach.json"), "{not json", "utf8");
    const bad = loadModelAttachConfig(dir);
    assert.equal(bad.ok, false);

    fs.writeFileSync(
      path.join(dir, "mpi-model-attach.json"),
      JSON.stringify({ skills: { rules: [{ match: { model: "*" }, add: ["a"] }] } }),
      "utf8",
    );
    const ok = loadModelAttachConfig(dir);
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
    assert.deepEqual(
      result.skills.map((s) => s.name),
      ["a"],
    );
    assert.equal(
      result.warnings.some((w) => w.kind === "remove"),
      true,
    );
    assert.equal(
      result.warnings.some((w) => w.kind === "add"),
      true,
    );
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
    writeSkill(root, "from-home", "From home path");
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
    assert.deepEqual(
      result.skills.map((s) => s.name),
      ["a"],
    );
  });
});

describe("formatModelAttachHelp", () => {
  test("documents config path, both sections, and example as markdown", () => {
    const help = formatModelAttachHelp("/tmp/agent/mpi-model-attach.json");
    assert.ok(help.includes("# /model-attach"));
    assert.ok(help.includes("/model-attach help"));
    assert.ok(help.includes("/model-attach skills on"));
    assert.ok(help.includes("/model-attach extensions off"));
    assert.ok(help.includes("/tmp/agent/mpi-model-attach.json"));
    assert.ok(help.includes("missingInput"));
    assert.ok(help.includes("$HOME"));
    assert.ok(help.includes("vision-proxy"));
    assert.ok(help.includes("```json"));
    assert.ok(!help.includes("/model-skills"));
    assert.ok(!help.includes("/model-extensions"));
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

  test("dollar signs in skill text are not replace patterns", () => {
    const a = syntheticSkill("old", "gone");
    const b = syntheticSkill("new", "regex $& and pid $$");
    const prompt = `You are pi.${formatSkillsForPrompt([a])}\nCurrent working directory: /tmp`;
    const next = replaceSkillsInSystemPrompt(prompt, [b]);
    assert.ok(!next.includes("<name>old</name>"));
    assert.ok(next.includes("pid $$"));
  });
});

describe("resolve + planModelExtensionLoads", () => {
  test("resolve entry file and directory", () => {
    const dir = tmpDir();
    const file = writeExt(dir, "alpha");
    const asFile = resolveExtensionEntry(file);
    assert.equal(asFile.ok, true);
    if (asFile.ok) assert.equal(asFile.path, path.resolve(file));

    const asDir = resolveExtensionEntry(path.join(dir, "alpha"));
    assert.equal(asDir.ok, true);
    if (asDir.ok) assert.equal(asDir.path, path.resolve(file));
  });

  test("resolve name under agentDir/extensions", () => {
    const agentDir = tmpDir();
    const file = writeExt(path.join(agentDir, "extensions"), "vision-helper");
    const hit = resolveExtensionName(agentDir, "vision-helper");
    assert.equal(hit.ok, true);
    if (hit.ok) assert.equal(hit.path, path.resolve(file));

    assert.equal(resolveExtensionName(agentDir, "../escape").ok, false);
    assert.equal(resolveExtensionName(agentDir, "missing").ok, false);
  });

  test("plan applies match, add path/name, remove by friendly name, order", () => {
    const agentDir = tmpDir();
    const a = writeExt(path.join(agentDir, "extensions"), "ext-a");
    const b = writeExt(path.join(agentDir, "extensions"), "ext-b");
    const side = writeExt(tmpDir(), "side-ext");

    const plan = planModelExtensionLoads(
      [
        {
          match: { model: "deepseek/*" },
          add: ["ext-a", "ext-b", side],
        },
        {
          match: { model: "deepseek/*" },
          remove: ["ext-a"],
          add: ["ext-b"],
        },
      ],
      noVision,
      agentDir,
    );

    assert.deepEqual(plan.matchedRuleIndexes, [0, 1]);
    assert.ok(plan.paths.includes(path.resolve(b)));
    assert.ok(plan.paths.includes(path.resolve(side)));
    assert.ok(!plan.paths.includes(path.resolve(a)));
    assert.equal(plan.paths[plan.paths.length - 1], path.resolve(b));
  });

  test("plan skips non-matching model and warns on bad add", () => {
    const agentDir = tmpDir();
    writeExt(path.join(agentDir, "extensions"), "only-deepseek");
    const plan = planModelExtensionLoads(
      [
        { match: { model: "deepseek/*" }, add: ["only-deepseek"] },
        { match: { model: "anthropic/*" }, add: ["nope"] },
      ],
      withVision,
      agentDir,
    );
    assert.deepEqual(plan.matchedRuleIndexes, [1]);
    assert.deepEqual(plan.paths, []);
    assert.equal(
      plan.warnings.some((w) => w.kind === "name"),
      true,
    );
  });

  test("friendlyExtensionName", () => {
    assert.equal(friendlyExtensionName("/x/y/ext-a/index.ts"), "ext-a");
    assert.equal(friendlyExtensionName("/x/y/ext-a.ts"), "ext-a");
  });

  test("resolveExtensionRef path form", () => {
    const dir = tmpDir();
    const file = writeExt(dir, "p");
    const r = resolveExtensionRef(dir, file);
    assert.equal(r.ok, true);
  });
});

describe("createDynamicExtensionLoader", () => {
  test("loads factory once and registers tools", async () => {
    const dir = tmpDir();
    const file = writeExt(dir, "dyn", "dyn_tool");
    const tools: string[] = [];
    const pi = {
      registerTool: (t: { name: string }) => {
        tools.push(t.name);
      },
    } as unknown as ExtensionAPI;

    const loader = createDynamicExtensionLoader();
    const first = await loader.loadPaths([file], pi);
    assert.deepEqual(first, [{ path: file, ok: true }]);
    assert.deepEqual(tools, ["dyn_tool"]);
    assert.equal(loader.loadedPaths.has(file), true);

    const second = await loader.loadPaths([file], pi);
    assert.deepEqual(second, [{ path: file, ok: true }]);
    assert.deepEqual(tools, ["dyn_tool"]);
  });

  test("reports error for missing file", async () => {
    const loader = createDynamicExtensionLoader();
    const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
    const results = await loader.loadPaths(["/no/such/ext/index.ts"], pi);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
  });
});

describe("modelKey", () => {
  test("joins provider/id", () => {
    assert.equal(modelKey(noVision), "deepseek/deepseek-v4-flash");
  });
});
