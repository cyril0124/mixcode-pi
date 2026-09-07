import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findModelRef } from "../src/core/models.js";
import { test } from "node:test";
import { $ } from "bun";
import { loadBatchRequests, type BatchLuaContext } from "../src/core/batch-lua.js";

const models = ["zeta", "alpha", "preferred"].map((provider) => ({
  id: `${provider}/shared`,
  provider,
  modelId: "shared",
  displayName: `${provider}/shared`,
  contextWindow: 200000,
  reasoning: true,
}));

async function resolveThroughScript(
  language: "lua" | "ts",
  query: unknown,
  context: BatchLuaContext,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-resolve-"));
  try {
    const file = path.join(dir, `script.${language}`);
    const argument = JSON.stringify(query);
    await Bun.write(
      file,
      language === "lua"
        ? `mixcode.open_tab({name="resolved", model=mixcode.resolve_model(${argument})})`
        : `export default (m) => m.openTab({name:"resolved", model:m.resolveModel(${argument})});`,
    );
    return (await loadBatchRequests(file, context)).requests[0]!.model;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const language of ["lua", "ts"] as const) {
  test(`${language} CLI dry-run resolves with Pi defaults and disabled policy without writes`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-resolve-cli-"));
    try {
      const agentDir = path.join(dir, "agent");
      const stateDir = path.join(agentDir, "mixcode-pi");
      await Bun.write(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: Object.fromEntries(
            ["alpha", "preferred", "zeta"].map((provider) => [
              provider,
              {
                baseUrl: "http://127.0.0.1:1/v1",
                api: "openai-completions",
                apiKey: "test-key",
                models: [
                  {
                    id: "shared",
                    name: "Shared",
                    reasoning: true,
                    contextWindow: 200000,
                    maxTokens: 4096,
                  },
                ],
              },
            ]),
          ),
        }),
      );
      await Bun.write(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "preferred", defaultModel: "shared" }),
      );
      const script = path.join(dir, `script.${language}`);
      await Bun.write(
        script,
        language === "lua"
          ? 'mixcode.open_tab({name="resolved", model=mixcode.resolve_model("shared")})'
          : 'export default m => m.openTab({name:"resolved", model:m.resolveModel("shared")});',
      );
      const settings = path.join(stateDir, "mixcode_settings.json");
      const invoke = () =>
        $`${process.execPath} src/cli/main.ts --workdir ${dir} --batch ${script} --batch-dry-run`
          .env({ ...process.env, PI_CODING_AGENT_DIR: agentDir, MIXCODE_STATE_DIR: stateDir })
          .quiet()
          .nothrow();
      await Bun.write(settings, "{}\n");
      const preferred = await invoke();
      assert.equal(preferred.exitCode, 0, preferred.stderr.toString());
      assert.match(preferred.text(), /model=preferred\/shared/);
      const projectDir = path.join(dir, ".pi");
      const projectSettings = path.join(projectDir, "settings.json");
      await Bun.write(projectSettings, JSON.stringify({ defaultProvider: "alpha" }));
      await fs.chmod(projectDir, 0o555);
      try {
        const readOnly = await invoke();
        assert.equal(readOnly.exitCode, 0, readOnly.stderr.toString());
        assert.match(readOnly.text(), /model=alpha\/shared/);
      } finally {
        await fs.chmod(projectDir, 0o755);
      }
      await fs.rm(projectSettings);
      const settingsLock = path.join(agentDir, "settings.json.lock");
      await fs.mkdir(settingsLock);
      try {
        const locked = await invoke();
        assert.equal(locked.exitCode, 0, locked.stderr.toString());
        assert.match(locked.text(), /model=preferred\/shared/);
      } finally {
        await fs.rm(settingsLock, { recursive: true, force: true });
      }
      for (const file of [path.join(agentDir, "settings.json"), projectSettings]) {
        const original = file === projectSettings ? undefined : await Bun.file(file).text();
        await Bun.write(file, "{ invalid json");
        const invalid = await invoke();
        assert.notEqual(invalid.exitCode, 0);
        assert.ok(invalid.stderr.toString().includes(`Error: ${file}:`));
        if (original === undefined) await fs.rm(file);
        else await Bun.write(file, original);
      }
      await Bun.write(settings, JSON.stringify({ disabledProviders: ["preferred"] }));
      const enabled = await invoke();
      assert.equal(enabled.exitCode, 0, enabled.stderr.toString());
      assert.match(enabled.text(), /model=alpha\/shared/);
      await Bun.write(
        settings,
        JSON.stringify({ disabledProviders: ["preferred", "alpha", "zeta"] }),
      );
      const unavailable = await invoke();
      assert.notEqual(unavailable.exitCode, 0);
      assert.match(unavailable.stderr.toString(), /Error: No available model matches: shared/);
      assert.deepEqual(await fs.readdir(stateDir), ["mixcode_settings.json"]);
      await assert.rejects(() => fs.access(path.join(agentDir, "sessions")), /ENOENT/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  const context: BatchLuaContext = {
    workdir: "/repo",
    tabs: [],
    models,
    defaultProvider: "preferred",
    disabledModelIds: [],
  };

  test(`${language} resolve model prefers the startup provider independently of catalog order`, async () => {
    for (const catalog of [models, [...models].reverse()]) {
      assert.equal(
        await resolveThroughScript(language, "shared", { ...context, models: catalog }),
        "preferred/shared",
      );
    }
  });

  test(`${language} resolve model uses lexical provider order when the default has no candidate`, async () => {
    assert.equal(
      await resolveThroughScript(language, " shared ", { ...context, defaultProvider: "absent" }),
      "alpha/shared",
    );
  });

  test(`${language} resolve model honors explicit references and complete slash-containing ids`, async () => {
    assert.equal(await resolveThroughScript(language, "zeta/shared", context), "zeta/shared");
    const catalog = [...models, { ...models[0]!, id: "zeta/org/model", modelId: "org/model" }];
    assert.equal(
      await resolveThroughScript(language, "org/model", { ...context, models: catalog }),
      "zeta/org/model",
    );
    const collision = [
      { ...models[0]!, id: "zeta/alpha/shared", modelId: "alpha/shared" },
      ...models,
    ];
    assert.equal(
      findModelRef(
        collision.map((model) => ({ ...model })),
        "alpha/shared",
      ).provider,
      "alpha",
    );
    assert.equal(
      await resolveThroughScript(language, "alpha/shared", { ...context, models: collision }),
      "alpha/shared",
    );
  });

  test(`${language} resolve model excludes disabled candidates without replacing explicit references`, async () => {
    const disabled = { ...context, disabledModelIds: ["preferred/shared", "alpha/shared"] };
    assert.equal(await resolveThroughScript(language, "shared", disabled), "zeta/shared");
    await assert.rejects(
      () => resolveThroughScript(language, "preferred/shared", disabled),
      /Error:.*disabled/i,
    );
    await assert.rejects(
      () =>
        resolveThroughScript(language, "shared", {
          ...context,
          disabledModelIds: models.map((m) => m.id),
        }),
      /Error:.*model/i,
    );
  });

  test(`${language} resolve model preserves percent characters in error diagnostics`, async () => {
    for (const query of ["%s", "%q", "%", "%%"]) {
      await assert.rejects(
        () => resolveThroughScript(language, query, context),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`Error: No available model matches: ${query}`),
      );
      const model = { ...models[0]!, modelId: query, id: `zeta/${query}` };
      await assert.rejects(
        () =>
          resolveThroughScript(language, model.id, {
            ...context,
            models: [model],
            disabledModelIds: [model.id],
          }),
        (error: unknown) =>
          error instanceof Error && error.message.includes(`Error: Model is disabled: ${model.id}`),
      );
    }
  });

  test(`${language} resolve model rejects invalid and unknown queries without fuzzy fallback`, async () => {
    for (const query of ["", "   ", 42]) {
      await assert.rejects(
        () => resolveThroughScript(language, query, context),
        /Error: Model query must be a non-empty string/,
      );
    }
    for (const query of ["sha", "missing/shared"]) {
      await assert.rejects(
        () => resolveThroughScript(language, query, context),
        /Error: No available model matches:/,
      );
    }
    await assert.rejects(
      () => resolveThroughScript(language, "shared", { ...context, models: [] }),
      /Error: No available model matches:/,
    );
  });
}
