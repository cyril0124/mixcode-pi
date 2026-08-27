import * as assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  expandEnvPath,
  formatModelExtensionsHelp,
  friendlyExtensionName,
  isModelExtensionsEnabled,
  isPathRef,
  loadModelExtensionsConfig,
  matchGlob,
  modelKey,
  parseModelExtensionsConfig,
  planModelExtensionLoads,
  resolveExtensionEntry,
  resolveExtensionName,
  resolveExtensionRef,
  ruleMatches,
  setModelExtensionsEnabled,
  type ModelLike,
} from "./model-extensions-core.js";
import { createDynamicExtensionLoader } from "./model-extensions-loader.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-model-extensions-"));
  tmpDirs.push(d);
  return d;
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
    assert.equal(isPathRef("vision-helper"), false);
    assert.equal(isPathRef("/abs/ext"), true);
    assert.equal(isPathRef("~/exts/x"), true);
    assert.equal(isPathRef("$HOME/exts/x"), true);
    assert.equal(isPathRef("$" + "{HOME}/exts/x"), true);
    assert.equal(isPathRef("./relative"), false);
  });

  test("expands HOME and rejects unknown env / relative", () => {
    const home = expandEnvPath("$HOME/foo");
    assert.equal(home.ok, true);
    if (home.ok) assert.equal(home.path, path.join(os.homedir(), "foo"));

    const missing = expandEnvPath("$MPI_MODEL_EXTENSIONS_NO_SUCH_VAR/x");
    assert.equal(missing.ok, false);

    assert.equal(expandEnvPath("relative/path").ok, false);
  });
});

describe("matchGlob / ruleMatches", () => {
  test("model glob", () => {
    assert.equal(matchGlob("deepseek/*", "deepseek/deepseek-v4-flash"), true);
    assert.equal(matchGlob("deepseek/*", "anthropic/claude"), false);
    assert.equal(matchGlob("*", "a/b"), true);
  });

  test("missingInput / hasInput", () => {
    assert.equal(ruleMatches({ missingInput: ["image"] }, noVision), true);
    assert.equal(ruleMatches({ missingInput: ["image"] }, withVision), false);
    assert.equal(ruleMatches({ hasInput: ["image"] }, withVision), true);
    assert.equal(ruleMatches({ hasInput: ["image"] }, noVision), false);
  });
});

describe("parseModelExtensionsConfig / load / setEnabled", () => {
  test("parses valid config", () => {
    const parsed = parseModelExtensionsConfig({
      enabled: true,
      rules: [{ match: { model: "deepseek/*" }, add: ["vision-helper"], remove: ["x"] }],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(isModelExtensionsEnabled(parsed.config), true);
      assert.equal(parsed.config.rules.length, 1);
    }
  });

  test("enabled false and missing defaults", () => {
    const off = parseModelExtensionsConfig({ enabled: false, rules: [] });
    assert.equal(off.ok, true);
    if (off.ok) assert.equal(isModelExtensionsEnabled(off.config), false);
    assert.equal(isModelExtensionsEnabled(null), true);
  });

  test("rejects bad shapes", () => {
    assert.equal(parseModelExtensionsConfig([]).ok, false);
    assert.equal(parseModelExtensionsConfig({ rules: [{ match: "x" }] }).ok, false);
    assert.equal(parseModelExtensionsConfig({ rules: [{ match: {}, add: [1] }] }).ok, false);
    assert.equal(parseModelExtensionsConfig({ enabled: "yes", rules: [] }).ok, false);
  });

  test("$schema: accepted as string, rejected otherwise, preserved by setModelExtensionsEnabled", () => {
    assert.equal(parseModelExtensionsConfig({ $schema: 1, rules: [] }).ok, false);
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "mpi-model-extensions.json"),
      JSON.stringify({ $schema: "./mpi-model-extensions.schema.json", rules: [] }),
      "utf8",
    );
    const off = setModelExtensionsEnabled(dir, false);
    assert.equal(off.ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "mpi-model-extensions.json"), "utf8"));
    assert.equal(Object.keys(raw)[0], "$schema");
    const loaded = loadModelExtensionsConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok && loaded.config)
      assert.equal(loaded.config.schemaRef, "./mpi-model-extensions.schema.json");
  });

  test("setModelExtensionsEnabled persists and preserves rules", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "mpi-model-extensions.json"),
      JSON.stringify({ rules: [{ match: { model: "a/*" }, add: ["x"] }] }, null, 2),
      "utf8",
    );
    const off = setModelExtensionsEnabled(dir, false);
    assert.equal(off.ok, true);
    if (off.ok) {
      assert.equal(off.config.enabled, false);
      assert.equal(off.config.rules.length, 1);
    }
    const loaded = loadModelExtensionsConfig(dir);
    assert.equal(loaded.ok && loaded.config && isModelExtensionsEnabled(loaded.config), false);

    const on = setModelExtensionsEnabled(dir, true);
    assert.equal(on.ok, true);
    if (on.ok) assert.equal(on.config.enabled, true);
  });

  test("load missing / bad json / ok", () => {
    const dir = tmpDir();
    const missing = loadModelExtensionsConfig(dir);
    assert.equal(missing.ok && "missing" in missing && missing.missing, true);

    fs.writeFileSync(path.join(dir, "mpi-model-extensions.json"), "{not json", "utf8");
    const bad = loadModelExtensionsConfig(dir);
    assert.equal(bad.ok, false);

    fs.writeFileSync(
      path.join(dir, "mpi-model-extensions.json"),
      JSON.stringify({ rules: [] }),
      "utf8",
    );
    const ok = loadModelExtensionsConfig(dir);
    assert.equal(ok.ok && !("missing" in ok), true);
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
    // ext-b re-added last among names; side kept
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

describe("formatModelExtensionsHelp", () => {
  test("includes command surface and path", () => {
    const help = formatModelExtensionsHelp("/tmp/agent/mpi-model-extensions.json");
    assert.ok(help.includes("# /model-extensions"));
    assert.ok(help.includes("/model-extensions help"));
    assert.ok(help.includes("/model-extensions on"));
    assert.ok(help.includes("/model-extensions off"));
    assert.ok(help.includes("/tmp/agent/mpi-model-extensions.json"));
  });
});

describe("modelKey", () => {
  test("joins provider/id", () => {
    assert.equal(modelKey(noVision), "deepseek/deepseek-v4-flash");
  });
});
