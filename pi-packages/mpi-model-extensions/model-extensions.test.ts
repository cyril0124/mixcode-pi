import { afterEach, describe, expect, test } from "bun:test";
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
const withVision: ModelLike = { id: "claude-sonnet", provider: "anthropic", input: ["text", "image"] };

describe("isPathRef / expandEnvPath", () => {
  test("classifies path vs name", () => {
    expect(isPathRef("vision-helper")).toBe(false);
    expect(isPathRef("/abs/ext")).toBe(true);
    expect(isPathRef("~/exts/x")).toBe(true);
    expect(isPathRef("$HOME/exts/x")).toBe(true);
    expect(isPathRef("$" + "{HOME}/exts/x")).toBe(true);
    expect(isPathRef("./relative")).toBe(false);
  });

  test("expands HOME and rejects unknown env / relative", () => {
    const home = expandEnvPath("$HOME/foo");
    expect(home.ok).toBe(true);
    if (home.ok) expect(home.path).toBe(path.join(os.homedir(), "foo"));

    const missing = expandEnvPath("$MPI_MODEL_EXTENSIONS_NO_SUCH_VAR/x");
    expect(missing.ok).toBe(false);

    expect(expandEnvPath("relative/path").ok).toBe(false);
  });
});

describe("matchGlob / ruleMatches", () => {
  test("model glob", () => {
    expect(matchGlob("deepseek/*", "deepseek/deepseek-v4-flash")).toBe(true);
    expect(matchGlob("deepseek/*", "anthropic/claude")).toBe(false);
    expect(matchGlob("*", "a/b")).toBe(true);
  });

  test("missingInput / hasInput", () => {
    expect(ruleMatches({ missingInput: ["image"] }, noVision)).toBe(true);
    expect(ruleMatches({ missingInput: ["image"] }, withVision)).toBe(false);
    expect(ruleMatches({ hasInput: ["image"] }, withVision)).toBe(true);
    expect(ruleMatches({ hasInput: ["image"] }, noVision)).toBe(false);
  });
});

describe("parseModelExtensionsConfig / load / setEnabled", () => {
  test("parses valid config", () => {
    const parsed = parseModelExtensionsConfig({
      enabled: true,
      rules: [{ match: { model: "deepseek/*" }, add: ["vision-helper"], remove: ["x"] }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isModelExtensionsEnabled(parsed.config)).toBe(true);
      expect(parsed.config.rules).toHaveLength(1);
    }
  });

  test("enabled false and missing defaults", () => {
    const off = parseModelExtensionsConfig({ enabled: false, rules: [] });
    expect(off.ok).toBe(true);
    if (off.ok) expect(isModelExtensionsEnabled(off.config)).toBe(false);
    expect(isModelExtensionsEnabled(null)).toBe(true);
  });

  test("rejects bad shapes", () => {
    expect(parseModelExtensionsConfig([]).ok).toBe(false);
    expect(parseModelExtensionsConfig({ rules: [{ match: "x" }] }).ok).toBe(false);
    expect(parseModelExtensionsConfig({ rules: [{ match: {}, add: [1] }] }).ok).toBe(false);
    expect(parseModelExtensionsConfig({ enabled: "yes", rules: [] }).ok).toBe(false);
  });

  test("setModelExtensionsEnabled persists and preserves rules", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "model-extensions.json"),
      JSON.stringify({ rules: [{ match: { model: "a/*" }, add: ["x"] }] }, null, 2),
      "utf8",
    );
    const off = setModelExtensionsEnabled(dir, false);
    expect(off.ok).toBe(true);
    if (off.ok) {
      expect(off.config.enabled).toBe(false);
      expect(off.config.rules).toHaveLength(1);
    }
    const loaded = loadModelExtensionsConfig(dir);
    expect(loaded.ok && loaded.config && isModelExtensionsEnabled(loaded.config)).toBe(false);

    const on = setModelExtensionsEnabled(dir, true);
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.config.enabled).toBe(true);
  });

  test("load missing / bad json / ok", () => {
    const dir = tmpDir();
    const missing = loadModelExtensionsConfig(dir);
    expect(missing.ok && "missing" in missing && missing.missing).toBe(true);

    fs.writeFileSync(path.join(dir, "model-extensions.json"), "{not json", "utf8");
    const bad = loadModelExtensionsConfig(dir);
    expect(bad.ok).toBe(false);

    fs.writeFileSync(
      path.join(dir, "model-extensions.json"),
      JSON.stringify({ rules: [] }),
      "utf8",
    );
    const ok = loadModelExtensionsConfig(dir);
    expect(ok.ok && !("missing" in ok)).toBe(true);
  });
});

describe("resolve + planModelExtensionLoads", () => {
  test("resolve entry file and directory", () => {
    const dir = tmpDir();
    const file = writeExt(dir, "alpha");
    const asFile = resolveExtensionEntry(file);
    expect(asFile.ok).toBe(true);
    if (asFile.ok) expect(asFile.path).toBe(path.resolve(file));

    const asDir = resolveExtensionEntry(path.join(dir, "alpha"));
    expect(asDir.ok).toBe(true);
    if (asDir.ok) expect(asDir.path).toBe(path.resolve(file));
  });

  test("resolve name under agentDir/extensions", () => {
    const agentDir = tmpDir();
    const file = writeExt(path.join(agentDir, "extensions"), "vision-helper");
    const hit = resolveExtensionName(agentDir, "vision-helper");
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.path).toBe(path.resolve(file));

    expect(resolveExtensionName(agentDir, "../escape").ok).toBe(false);
    expect(resolveExtensionName(agentDir, "missing").ok).toBe(false);
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

    expect(plan.matchedRuleIndexes).toEqual([0, 1]);
    expect(plan.paths).toContain(path.resolve(b));
    expect(plan.paths).toContain(path.resolve(side));
    expect(plan.paths).not.toContain(path.resolve(a));
    // ext-b re-added last among names; side kept
    expect(plan.paths[plan.paths.length - 1]).toBe(path.resolve(b));
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
    expect(plan.matchedRuleIndexes).toEqual([1]);
    expect(plan.paths).toEqual([]);
    expect(plan.warnings.some((w) => w.kind === "name")).toBe(true);
  });

  test("friendlyExtensionName", () => {
    expect(friendlyExtensionName("/x/y/ext-a/index.ts")).toBe("ext-a");
    expect(friendlyExtensionName("/x/y/ext-a.ts")).toBe("ext-a");
  });

  test("resolveExtensionRef path form", () => {
    const dir = tmpDir();
    const file = writeExt(dir, "p");
    const r = resolveExtensionRef(dir, file);
    expect(r.ok).toBe(true);
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
    expect(first).toEqual([{ path: file, ok: true }]);
    expect(tools).toEqual(["dyn_tool"]);
    expect(loader.loadedPaths.has(file)).toBe(true);

    const second = await loader.loadPaths([file], pi);
    expect(second).toEqual([{ path: file, ok: true }]);
    expect(tools).toEqual(["dyn_tool"]);
  });

  test("reports error for missing file", async () => {
    const loader = createDynamicExtensionLoader();
    const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
    const results = await loader.loadPaths(["/no/such/ext/index.ts"], pi);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
  });
});

describe("formatModelExtensionsHelp", () => {
  test("includes command surface and path", () => {
    const help = formatModelExtensionsHelp("/tmp/agent/model-extensions.json");
    expect(help).toContain("# /model-extensions");
    expect(help).toContain("/model-extensions help");
    expect(help).toContain("/model-extensions on");
    expect(help).toContain("/model-extensions off");
    expect(help).toContain("/tmp/agent/model-extensions.json");
  });
});

describe("modelKey", () => {
  test("joins provider/id", () => {
    expect(modelKey(noVision)).toBe("deepseek/deepseek-v4-flash");
  });
});
