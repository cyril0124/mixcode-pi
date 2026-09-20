import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  type BatchLuaContext,
  type BatchLuaModelInfo,
  type BatchLuaTabInfo,
  contextFromState,
  formatBatchPlan,
  loadBatchRequests,
  validateBatchRequests,
} from "../src/core/batch-lua.js";
import type {
  MixCodeBatchApi as RuntimeBatchApi,
  MixCodeBatchOpenTabOptions as RuntimeOpenTabOptions,
} from "../src/core/batch-ts.js";
import { createInitialState, createTab } from "./helpers/mixcode.js";

/**
 * Compile-time drift guard: the unprefixed names below are the globals declared
 * by the root `mixcode-batch.d.ts` stub that user scripts reference. They must
 * stay structurally identical to what the executor passes in. Key equality is
 * checked explicitly because assignability alone ignores renamed optional
 * fields, and method parameters compare bivariantly.
 */
type Same<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [keyof A] extends [keyof B]
      ? [keyof B] extends [keyof A]
        ? true
        : never
      : never
    : never
  : never;
export const stubApiMatches: Same<RuntimeBatchApi, MixCodeBatchApi> = true;
export const stubOptionsMatch: Same<RuntimeOpenTabOptions, MixCodeBatchOpenTabOptions> = true;
export const stubTabInfoMatches: Same<BatchLuaTabInfo, MixCodeBatchTabInfo> = true;
export const stubModelInfoMatches: Same<BatchLuaModelInfo, MixCodeBatchModelInfo> = true;

async function withScript<T>(
  filename: string,
  source: string,
  run: (scriptPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "batch-ts-"));
  try {
    const scriptPath = path.join(dir, filename);
    await fsPromises.writeFile(scriptPath, source);
    return await run(scriptPath);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

function testContext(): BatchLuaContext {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo/pkg", { title: "existing" }));
  return { ...contextFromState(state), args: ["packages/core", "packages/cli"] };
}

test("loadBatchRequests runs a .ts script and collects openTab calls", async () => {
  const plan = await withScript(
    "script.ts",
    `export default (mixcode: any) => {
       mixcode.openTab({
         name: "review",
         prompt: "Review the branch.",
         workdir: "/repo/pkg",
         model: "anthropic/claude-sonnet-4-20250514",
         thinking: "low",
         systemPrompt: "You are terse.",
         mode: "delete",
       });
       mixcode.openTab({ name: "scratch" });
     };`,
    (scriptPath) => loadBatchRequests(scriptPath, testContext()),
  );

  assert.deepEqual(plan.requests, [
    {
      name: "review",
      prompt: "Review the branch.",
      workdir: "/repo/pkg",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: "low",
      systemPrompt: "You are terse.",
      mode: "delete",
    },
    {
      name: "scratch",
      prompt: undefined,
      workdir: undefined,
      model: undefined,
      thinking: undefined,
      systemPrompt: undefined,
      mode: undefined,
    },
  ]);
});

test("Lua and TS reject clear with empty system prompt during preflight", async () => {
  for (const [filename, source] of [
    ["invalid.lua", 'mixcode.open_tab({ name = "missing", mode = "clear", system_prompt = "" })'],
    [
      "invalid.ts",
      'export default (mixcode) => mixcode.openTab({ name: "missing", mode: "clear", systemPrompt: "" });',
    ],
  ]) {
    await withScript(filename!, source!, async (scriptPath) => {
      const plan = await loadBatchRequests(scriptPath, testContext());
      assert.equal(plan.requests[0]!.systemPrompt, "");
      assert.throws(
        () => validateBatchRequests(plan.requests, () => createInitialState("/repo").model),
        {
          message: /^Error:.*system_prompt.*mode="clear"/,
        },
      );
    });
  }
});

for (const extension of ["lua", "ts"]) {
  test(`${extension} normalizes context limits and includes them in dry-run`, async () => {
    const cases = [
      { input: 32_000, expected: 32_000 },
      { input: Number.MAX_SAFE_INTEGER, expected: Number.MAX_SAFE_INTEGER },
      { input: "32.5K", expected: 32_500 },
      { input: " 32000 ", expected: 32_000 },
      { input: "32.5", expected: 33 },
      { input: " RESET ", expected: "reset" },
    ];
    const calls = cases.map(({ input }, index) =>
      extension === "lua"
        ? `mixcode.open_tab({ name = "tab-${index}", context_limit = ${JSON.stringify(input)} })`
        : `mixcode.openTab({ name: "tab-${index}", contextLimit: ${JSON.stringify(input)} });`,
    );
    const source =
      extension === "lua"
        ? calls.join("\n")
        : `export default (mixcode) => { ${calls.join("\n")} };`;
    await withScript(`limits.${extension}`, source, async (scriptPath) => {
      const plan = await loadBatchRequests(scriptPath, testContext());
      assert.deepEqual(
        plan.requests.map((request) => request.contextLimit),
        cases.map(({ expected }) => expected),
      );
      const output = formatBatchPlan(plan);
      assert.match(output, /name=tab-0 context_limit=32000/);
      assert.match(output, /name=tab-5 context_limit=reset/);
    });
  });

  test(`${extension} treats nullish context limits as omitted`, async () => {
    const source =
      extension === "lua"
        ? 'mixcode.open_tab({ name = "omitted", context_limit = nil })'
        : 'export default (mixcode) => { mixcode.openTab({ name: "omitted", contextLimit: null }); mixcode.openTab({ name: "undefined", contextLimit: undefined }); };';
    await withScript(`omitted.${extension}`, source, async (scriptPath) => {
      const plan = await loadBatchRequests(scriptPath, testContext());
      assert.deepEqual(
        plan.requests.map((request) => request.contextLimit),
        extension === "lua" ? [undefined] : [undefined, undefined],
      );
      assert.doesNotMatch(formatBatchPlan(plan), /context_limit=/);
    });
  });

  test(`${extension} rejects invalid context limits with script and tab identity`, async () => {
    const invalid = [
      "0",
      "-1",
      "1.5",
      "true",
      '"bad"',
      '"0k"',
      '"1e3"',
      '"999999999999999999999k"',
      "9007199254740992",
    ];
    invalid.push(
      "{}",
      extension === "lua" ? "0/0" : "NaN",
      extension === "lua" ? "math.huge" : "Infinity",
    );
    for (const value of invalid) {
      const source =
        extension === "lua"
          ? `mixcode.open_tab({ name = "invalid-limit", context_limit = ${value} })`
          : `export default (mixcode) => mixcode.openTab({ name: "invalid-limit", contextLimit: ${value} });`;
      await withScript(`invalid-limit.${extension}`, source, async (scriptPath) => {
        await assert.rejects(
          () => loadBatchRequests(scriptPath, testContext()),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(scriptPath));
            assert.match(error.message, /Error: Invalid context limit.*invalid-limit/);
            return true;
          },
        );
      });
    }
  });
}

test("Lua and TS collect exclusive prompt sequences and preview every round", async () => {
  const prompts = ["first task", "/skill:review keep  spacing\nnext line", "/unknown"];
  const ts = await withScript(
    "sequence.ts",
    `export default api => api.openTab({ name: "sequence", prompts: ${JSON.stringify(prompts)} });`,
    (file) => loadBatchRequests(file),
  );
  const lua = await withScript(
    "sequence.lua",
    'mixcode.open_tab({name="sequence", prompts={"first task", [[/skill:review keep  spacing\nnext line]], "/unknown"}})',
    (file) => loadBatchRequests(file),
  );
  assert.deepEqual(ts, lua);
  assert.deepEqual(ts.requests[0]!.prompts, prompts);
  assert.match(formatBatchPlan(ts), /prompts: 3 exclusive round\(s\)/);
  for (const [index, prompt] of prompts.entries()) {
    assert.ok(formatBatchPlan(ts).includes(`${index + 1}. ${prompt}`));
  }
});

for (const extension of ["ts", "lua"]) {
  test(`${extension} omits blank sequence entries from execution plans and dry-run`, async () => {
    const source =
      extension === "ts"
        ? 'export default api => api.openTab({name:"sequence", prompts:["", "  first  ", " \\t\\n", "/color red", ""]});'
        : 'mixcode.open_tab({name="sequence", prompts={"", "  first  ", " \\t\\n", "/color red", ""}})';
    const plan = await withScript(`blanks.${extension}`, source, (file) => loadBatchRequests(file));
    assert.deepEqual(plan.requests[0]!.prompts, ["  first  ", "/color red"]);
    assert.match(formatBatchPlan(plan), /prompts: 2 exclusive round\(s\)/);
    assert.ok(formatBatchPlan(plan).includes("     1.   first  \n     2. /color red"));
  });

  test(`${extension} rejects malformed prompt sequences before collecting a plan`, async () => {
    const invalid =
      extension === "ts"
        ? [
            'prompts: "text"',
            "prompts: []",
            'prompts: ["valid", 42]',
            'prompts: ["", ""]',
            'prompts: ["", " \\t\\n"]',
            'prompts: ["valid", , "last"]',
            'prompt: "first", prompts: ["second"]',
            'prompts: ["valid", null]',
            'prompts: ["valid", " !echo forbidden"]',
            'prompts: ["!!echo forbidden"]',
          ]
        : [
            'prompts="text"',
            "prompts={}",
            'prompts={"valid", 42}',
            'prompts={"", ""}',
            'prompts={"", " \\t\\n"}',
            'prompts={[1]="first", [3]="last"}',
            'prompts={[1]="first", extra="last"}',
            'prompts={[0]="first"}',
            'prompt="first", prompts={"second"}',
            'prompts={"valid", false}',
            'prompts={"valid", " !echo forbidden"}',
            'prompts={"!!echo forbidden"}',
          ];
    for (const fields of invalid) {
      const source =
        extension === "ts"
          ? `export default api => api.openTab({name:"bad-sequence", ${fields}});`
          : `mixcode.open_tab({name="bad-sequence", ${fields}})`;
      await withScript(`invalid.${extension}`, source, async (file) => {
        await assert.rejects(loadBatchRequests(file), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(file), error.message);
          assert.match(error.message, /Error:.*prompts.*bad-sequence/);
          return true;
        });
      });
    }
  });
}

test("TS snapshots the prompts array and treats nullish sequences as omitted", async () => {
  const plan = await withScript(
    "snapshot.ts",
    `export default api => {
      const prompts = ["original"];
      api.openTab({name: "snapshot", prompts});
      prompts[0] = "changed";
      api.openTab({name: "none", prompt: "single", prompts: null});
    };`,
    (file) => loadBatchRequests(file),
  );
  assert.deepEqual(plan.requests[0]!.prompts, ["original"]);
  assert.equal(plan.requests[1]!.prompts, undefined);
  assert.equal(plan.requests[1]!.prompt, "single");
});

test("loadBatchRequests awaits async .ts scripts", async () => {
  const plan = await withScript(
    "async.ts",
    `export default async (mixcode: any) => {
       await new Promise((resolve) => setTimeout(resolve, 5));
       mixcode.openTab({ name: "late", prompt: "after await" });
     };`,
    (scriptPath) => loadBatchRequests(scriptPath, testContext()),
  );
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0]!.prompt, "after await");
});

test("TS and Lua scripts produce equivalent plans for the same scenario", async () => {
  const context = testContext();
  const tsPlan = await withScript(
    "same.ts",
    `export default (mixcode: any) => {
       for (const pkg of mixcode.args()) {
         mixcode.openTab({ name: \`lint-\${pkg}\`, workdir: pkg, thinking: "low", prompt: \`Lint \${pkg}.\` });
       }
     };`,
    (scriptPath) => loadBatchRequests(scriptPath, context),
  );
  const luaPlan = await withScript(
    "same.lua",
    `for _, pkg in ipairs(mixcode.args()) do
       mixcode.open_tab({ name = "lint-" .. pkg, workdir = pkg, thinking = "low", prompt = "Lint " .. pkg .. "." })
     end`,
    (scriptPath) => loadBatchRequests(scriptPath, context),
  );
  assert.equal(formatBatchPlan(tsPlan), formatBatchPlan(luaPlan));
  assert.equal(tsPlan.requests.length, 2);
});

test("TS scripts read the script directory, not the invocation workdir", async () => {
  let scriptDir = "";
  const plan = await withScript(
    "script-dir.ts",
    `export default (mixcode: any) => {
       mixcode.openTab({ name: "dir", prompt: mixcode.scriptDir() + "|" + mixcode.currentWorkdir() });
     };`,
    (scriptPath) => {
      scriptDir = path.dirname(scriptPath);
      return loadBatchRequests(scriptPath, testContext());
    },
  );
  assert.equal(plan.requests[0]!.prompt, `${scriptDir}|/repo`);
  assert.notEqual(scriptDir, "/repo");
});

test("TS scripts read the startup context snapshot", async () => {
  const plan = await withScript(
    "context.ts",
    `export default (mixcode: any) => {
       mixcode.openTab({
         name: "info",
         prompt: [
           mixcode.currentWorkdir(),
           String(mixcode.tabExists("existing")),
           String(mixcode.tabExists("missing")),
           mixcode.listTabs().map((t: any) => t.name + ":" + t.sessionId + ":" + t.workdir).join(","),
           mixcode.listModels().map((m: any) => m.id + ":" + m.contextWindow + ":" + m.reasoning).join(","),
           mixcode.args().join("|"),
         ].join(" "),
       });
     };`,
    (scriptPath) => loadBatchRequests(scriptPath, testContext()),
  );
  const context = testContext();
  const model = context.models![0]!;
  assert.equal(
    plan.requests[0]!.prompt,
    `/repo true false existing:s1:/repo/pkg ${model.id}:${model.contextWindow}:${model.reasoning} packages/core|packages/cli`,
  );
});

test("TS listTabs returns copies so scripts cannot mutate host state", async () => {
  const context = testContext();
  await withScript(
    "mutate.ts",
    `export default (mixcode: any) => {
       mixcode.listTabs()[0].name = "hijacked";
       mixcode.openTab({ name: mixcode.listTabs()[0].name });
     };`,
    (scriptPath) => loadBatchRequests(scriptPath, context),
  );
  assert.equal(context.tabs[0]!.name, "existing");
});

test("TS render fills templates and rejects missing variables", async () => {
  const plan = await withScript(
    "render.ts",
    `export default (mixcode: any) => {
       mixcode.openTab({ name: "r", prompt: mixcode.render("{a}-{{lit}}-{b}", { a: "x", b: 2 }) });
     };`,
    (scriptPath) => loadBatchRequests(scriptPath, testContext()),
  );
  assert.equal(plan.requests[0]!.prompt, "x-{lit}-2");

  // null behaves like Lua's nil: missing, not the literal string "null".
  for (const source of [
    `export default (mixcode: any) => {
       mixcode.openTab({ name: "r", prompt: mixcode.render("{missing}", {}) });
     };`,
    `export default (mixcode: any) => {
       mixcode.openTab({ name: "r", prompt: mixcode.render("{missing}", { missing: null }) });
     };`,
  ]) {
    await withScript("render-missing.ts", source, async (scriptPath) =>
      assert.rejects(
        () => loadBatchRequests(scriptPath, testContext()),
        /Missing template variable: missing/,
      ),
    );
  }
});

test("script load and runtime failures name the failing script", async () => {
  await withScript("broken.ts", `export default (mixcode: any) => {`, async (scriptPath) =>
    assert.rejects(
      () => loadBatchRequests(scriptPath, testContext()),
      (error: Error) =>
        error.message.startsWith("Batch script error in ") && error.message.includes(scriptPath),
    ),
  );
  await withScript(
    "throws.ts",
    `export default () => { throw new Error("boom from script"); };`,
    async (scriptPath) =>
      assert.rejects(
        () => loadBatchRequests(scriptPath, testContext()),
        (error: Error) =>
          error.message.includes(scriptPath) && error.message.includes("boom from script"),
      ),
  );
});

test("loadBatchRequests rejects a TS script without a callable default export", async () => {
  await withScript("no-default.ts", `export const script = () => {};`, async (scriptPath) =>
    assert.rejects(
      () => loadBatchRequests(scriptPath, testContext()),
      /must default-export a function/,
    ),
  );
  await withScript("bad-default.ts", `export default { name: "nope" };`, async (scriptPath) =>
    assert.rejects(
      () => loadBatchRequests(scriptPath, testContext()),
      /must default-export a function/,
    ),
  );
});

test("openTab validates option types", async () => {
  await withScript(
    "no-name.ts",
    `export default (mixcode: any) => mixcode.openTab({ prompt: "x" });`,
    async (scriptPath) =>
      assert.rejects(
        () => loadBatchRequests(scriptPath, testContext()),
        /'name' must be a non-empty string/,
      ),
  );
  await withScript(
    "bad-prompt.ts",
    `export default (mixcode: any) => mixcode.openTab({ name: "t", prompt: 42 });`,
    async (scriptPath) =>
      assert.rejects(
        () => loadBatchRequests(scriptPath, testContext()),
        /'prompt' must be a string for tab 't'/,
      ),
  );
  // Lua spells this field system_prompt; silently dropping it would change the
  // session identity without any signal.
  await withScript(
    "snake-case.ts",
    `export default (mixcode: any) => mixcode.openTab({ name: "t", system_prompt: "S" });`,
    async (scriptPath) =>
      assert.rejects(
        () => loadBatchRequests(scriptPath, testContext()),
        /unknown field\(s\) system_prompt/,
      ),
  );
});

test("loadBatchRequests rejects unsupported script extensions", async () => {
  await assert.rejects(
    () => loadBatchRequests("/tmp/script.py", testContext()),
    /Unsupported batch script extension '\.py'/,
  );
});

test("loadBatchRequests runs plain .js batch scripts", async () => {
  const plan = await withScript(
    "script.mjs",
    `export default (mixcode) => mixcode.openTab({ name: "js", prompt: "from js" });`,
    (scriptPath) => loadBatchRequests(scriptPath, testContext()),
  );
  assert.equal(plan.requests[0]!.prompt, "from js");
});

test("shipped TS examples load through the real batch pipeline", async () => {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const plan = await loadBatchRequests(path.join(repoRoot, "examples/batch/monorepo.ts"), {
    ...testContext(),
    args: ["packages/core"],
  });
  assert.deepEqual(
    plan.requests.map((request) => request.name),
    ["core-lint", "summary"],
  );
  assert.equal(plan.requests[1]!.prompt, "Summarize lint results across 1 package(s) in /repo.");
});
