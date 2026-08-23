import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  contextFromState,
  formatBatchPlan,
  loadBatchRequests,
  type BatchLuaContext,
  type BatchLuaModelInfo,
  type BatchLuaTabInfo,
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
         mode: "clear",
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
      mode: "clear",
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
