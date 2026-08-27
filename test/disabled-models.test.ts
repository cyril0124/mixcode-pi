import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  applyDisabledModelFlags,
  assertModelEnabled,
  configureDisabledModelRuntime,
  createPiModelRuntimeAuth,
  createInitialState,
  createPicker,
  createTab,
  isModelDisabled,
  loadMixCodeSettings,
  loadRawMixCodeSettings,
  modelToRef,
  writeRawMixCodeSettings,
  type MixCodeModelRef,
} from "./helpers/mixcode.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { pickerItems } from "../src/core/pickers.js";
import { applyModelSelection, reloadRuntimeModels } from "../src/ui/app-actions.js";
import { submitAgentInput } from "../src/ui/agent-tab-actions.js";

const openaiGpt: MixCodeModelRef = {
  provider: "openai",
  modelId: "gpt-4",
  displayName: "openai/gpt-4",
  contextWindow: 128_000,
};
const anthropicOpus: MixCodeModelRef = {
  provider: "anthropic",
  modelId: "claude-opus",
  displayName: "anthropic/claude-opus",
  contextWindow: 200_000,
};

async function createPolicyRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const { provider: disabledProvider } = fauxProvider({
    provider: "disabled-provider",
    models: [{ id: "disabled-model", name: "Disabled Model" }],
  });
  const { provider: enabledProvider } = fauxProvider({
    provider: "enabled-provider",
    models: [
      { id: "enabled-model", name: "Enabled Model" },
      { id: "disabled-model", name: "Individually Disabled Model" },
    ],
  });
  runtime.registerNativeProvider(disabledProvider);
  runtime.registerNativeProvider(enabledProvider);
  await runtime.setRuntimeApiKey("disabled-provider", "test-key");
  await runtime.setRuntimeApiKey("enabled-provider", "test-key");
  await runtime.getAvailable();
  return runtime;
}

test("isModelDisabled matches provider list and provider/modelId list", () => {
  assert.equal(isModelDisabled("openai", "gpt-4", ["openai"], []), true);
  assert.equal(isModelDisabled("openai", "gpt-4", [], ["openai/gpt-4"]), true);
  assert.equal(isModelDisabled("openai", "gpt-4o", [], ["openai/gpt-4"]), false);
  assert.equal(isModelDisabled("anthropic", "claude-opus", ["openai"], ["openai/gpt-4"]), false);
  // modelId may contain slashes; match on first slash only
  assert.equal(isModelDisabled("custom", "org/model", [], ["custom/org/model"]), true);
});

test("mixcode settings load/write disabledProviders and disabledModels", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-disabled-settings-"));
  const file = path.join(dir, "mixcode_settings.json");
  try {
    await fsPromises.writeFile(
      file,
      JSON.stringify({
        disabledProviders: ["openai", "  "],
        disabledModels: ["anthropic/claude-opus", 1, ""],
      }),
      "utf8",
    );
    const loaded = await loadMixCodeSettings(file);
    assert.deepEqual(loaded.disabledProviders, ["openai"]);
    assert.deepEqual(loaded.disabledModels, ["anthropic/claude-opus"]);

    await writeRawMixCodeSettings(file, {
      disabledProviders: ["google"],
      disabledModels: ["openai/gpt-4"],
    });
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.disabledProviders, ["google"]);
    assert.deepEqual(raw.disabledModels, ["openai/gpt-4"]);
    const rawLoaded = await loadRawMixCodeSettings(file);
    assert.deepEqual(rawLoaded.disabledProviders, ["google"]);
    assert.deepEqual(rawLoaded.disabledModels, ["openai/gpt-4"]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("applyDisabledModelFlags stamps disabled without dropping models", () => {
  const stamped = applyDisabledModelFlags(
    [openaiGpt, anthropicOpus],
    ["openai"],
    ["anthropic/claude-opus"],
  );
  assert.equal(stamped.length, 2);
  assert.equal(stamped[0]!.disabled, true);
  assert.equal(stamped[1]!.disabled, true);

  const onlyProvider = applyDisabledModelFlags([openaiGpt, anthropicOpus], ["openai"], []);
  assert.equal(onlyProvider[0]!.disabled, true);
  assert.equal(onlyProvider[1]!.disabled, undefined);
});

test("disabled model policy filters extension availability but preserves the full catalog", async () => {
  const runtime = await createPolicyRuntime();
  const registry = new ModelRegistry(runtime);

  configureDisabledModelRuntime(
    runtime,
    ["disabled-provider"],
    ["enabled-provider/disabled-model"],
  );

  assert.deepEqual(
    registry
      .getAvailable()
      .filter(
        (model) => model.provider === "disabled-provider" || model.provider === "enabled-provider",
      )
      .map((model) => `${model.provider}/${model.id}`),
    ["enabled-provider/enabled-model"],
  );
  assert.deepEqual(
    registry
      .getAll()
      .filter(
        (model) => model.provider === "disabled-provider" || model.provider === "enabled-provider",
      )
      .map((model) => `${model.provider}/${model.id}`)
      .sort(),
    [
      "disabled-provider/disabled-model",
      "enabled-provider/disabled-model",
      "enabled-provider/enabled-model",
    ],
  );

  // Reconfiguration updates the existing wrapper instead of stacking another one.
  configureDisabledModelRuntime(runtime, [], []);
  assert.deepEqual(
    registry
      .getAvailable()
      .filter(
        (model) => model.provider === "disabled-provider" || model.provider === "enabled-provider",
      )
      .map((model) => `${model.provider}/${model.id}`)
      .sort(),
    [
      "disabled-provider/disabled-model",
      "enabled-provider/disabled-model",
      "enabled-provider/enabled-model",
    ],
  );
});

test("disabled model policy rejects an already resolved model before provider execution", async () => {
  const runtime = await createPolicyRuntime();
  const disabled = runtime.getModel("disabled-provider", "disabled-model");
  assert.ok(disabled);

  configureDisabledModelRuntime(runtime, ["disabled-provider"], []);

  assert.throws(
    () => runtime.streamSimple(disabled, { messages: [] }),
    /Model is disabled: disabled-provider\/disabled-model/,
  );
});

test("disabled model policy rejects the runtime auth stream path", async () => {
  const faux = registerFauxProvider({
    provider: "disabled-runtime-auth",
    api: "disabled-runtime-auth-api",
  });
  try {
    faux.setResponses([() => fauxAssistantMessage("unexpected")]);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerProvider("disabled-runtime-auth", {
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      api: "disabled-runtime-auth-api",
      models: [
        {
          id: "blocked",
          name: "Blocked",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8_000,
          maxTokens: 1_024,
        },
      ],
    });
    const model = runtime.getModel("disabled-runtime-auth", "blocked");
    assert.ok(model);
    configureDisabledModelRuntime(runtime, ["disabled-runtime-auth"], []);

    await assert.rejects(
      async () =>
        await createPiModelRuntimeAuth(runtime).stream(model, {
          systemPrompt: "",
          messages: [],
          tools: [],
        }),
      /Model is disabled: disabled-runtime-auth\/blocked/,
    );
  } finally {
    faux.unregister();
  }
});

test("reloadRuntimeModels updates the shared extension model policy", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-disabled-reload-"));
  const file = path.join(dir, "mixcode_settings.json");
  const runtime = await createPolicyRuntime();
  const registry = new ModelRegistry(runtime);
  const configured = runtime
    .getModels()
    .filter(
      (model) => model.provider === "disabled-provider" || model.provider === "enabled-provider",
    )
    .map(modelToRef);
  const state = createInitialState("/repo");

  try {
    await fsPromises.writeFile(
      file,
      JSON.stringify({ disabledProviders: ["disabled-provider"] }),
      "utf8",
    );
    assert.deepEqual(
      await reloadRuntimeModels(
        state,
        testRuntime({
          reloadModelConfig: async () => configured,
          getSharedModelRuntime: () => runtime,
          refreshScopedModels: () => {},
        }),
        { mixcodeFile: file },
      ),
      { ok: true },
    );
    assert.equal(
      registry.getAvailable().some((model) => model.provider === "disabled-provider"),
      false,
    );

    await fsPromises.writeFile(file, "{}", "utf8");
    await reloadRuntimeModels(
      state,
      testRuntime({
        reloadModelConfig: async () => configured,
        getSharedModelRuntime: () => runtime,
        refreshScopedModels: () => {},
      }),
      { mixcodeFile: file },
    );
    assert.equal(
      registry.getAvailable().some((model) => model.provider === "disabled-provider"),
      true,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("reload applies disabled policy when models.json is invalid", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-disabled-error-"));
  const file = path.join(dir, "mixcode_settings.json");
  const runtime = await createPolicyRuntime();
  const registry = new ModelRegistry(runtime);
  const state = createInitialState("/repo");
  state.availableModels = runtime.getModels().map(modelToRef);
  runtime.getError = () => "Failed to parse models.json";

  try {
    await fsPromises.writeFile(
      file,
      JSON.stringify({ disabledProviders: ["disabled-provider"] }),
      "utf8",
    );
    assert.deepEqual(
      await reloadRuntimeModels(
        state,
        testRuntime({
          reloadModelConfig: async () => [],
          getSharedModelRuntime: () => runtime,
          refreshScopedModels: () => {},
        }),
        { mixcodeFile: file },
      ),
      { ok: false, error: "Failed to parse models.json" },
    );
    assert.equal(
      registry.getAvailable().some((model) => model.provider === "disabled-provider"),
      false,
    );
    assert.equal(
      state.availableModels.find((model) => model.provider === "disabled-provider")?.disabled,
      true,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("models picker marks disabled items and keeps them listed", () => {
  const state = createInitialState("/repo");
  state.availableModels = applyDisabledModelFlags([openaiGpt, anthropicOpus], ["openai"], []);
  const items = pickerItems("models", state);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.disabled, true);
  assert.match(items[0]!.description, /disabled/i);
  assert.equal(items[1]!.disabled, undefined);
  assert.match(items[1]!.description, /context/);

  const picker = createPicker("models", state);
  assert.equal(
    picker.items.some((item) => item.id === "openai/gpt-4" && item.disabled),
    true,
  );
});

test("applyModelSelection rejects disabled models", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { model: anthropicOpus });
  state.tabs = [tab];
  state.model = anthropicOpus;
  const disabled = { ...openaiGpt, disabled: true };
  await assert.rejects(() => applyModelSelection(state, tab, disabled), /disabled/i);
  assert.equal(tab.model.modelId, "claude-opus");
});

test("assertModelEnabled and submitAgentInput reject disabled current model", async () => {
  const disabled = { ...openaiGpt, disabled: true };
  assert.throws(() => assertModelEnabled(disabled), /disabled/i);

  const tab = createTab(1, "s1", "/repo", { model: disabled });
  let prompted = false;
  await assert.rejects(
    () =>
      submitAgentInput(
        tab,
        {
          prompt: async () => {
            prompted = true;
          },
          getTab: () => undefined,
        } as never,
        "hello",
      ),
    /disabled/i,
  );
  assert.equal(prompted, false);
});
