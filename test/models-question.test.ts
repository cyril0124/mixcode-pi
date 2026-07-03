import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  getApiProvider,
  registerApiProvider,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  DEFAULT_MODEL_REF,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createPiModelRegistryBundle,
  createPiModelRuntimeAuth,
  createInitialState,
  createTab,
  defaultPiAuthPath,
  defaultPiModelsPath,
  findModelRef,
  listAvailableModelRefs,
  loadPiModelSources,
  modelToRef,
  registerModels,
  setStateModel,
  setTabModel,
} from "../src/index.js";

test("model helpers map pi models into MixCode state", () => {
  const ref = modelToRef(MIXCODE_FAUX_MODEL);
  assert.equal(ref.displayName, "faux/faux-1");
  const state = createInitialState("/repo");
  setStateModel(state, ref);
  assert.equal(state.model.modelId, "faux-1");
  const tab = createTab(1, "s1", "/repo");
  setTabModel(tab, { ...ref, contextWindow: 123 });
  assert.equal(tab.contextLimit, 123);
  assert.equal(findModelRef([ref], "faux-1").provider, "faux");
  assert.equal(findModelRef([ref], "faux/faux-1").modelId, "faux-1");
  assert.throws(() => findModelRef([DEFAULT_MODEL_REF], "missing"), /Unknown model/);
  assert.ok(Array.isArray(listAvailableModelRefs()));
});

test("proxy-gpt model loads through pi models.json registry as OpenAI Responses without storing secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-model-config-"));
  const oldKey = process.env.MIXCODE_TEST_PROXY_KEY;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.MIXCODE_TEST_PROXY_KEY = "secret-key";
    process.env.PI_CODING_AGENT_DIR = dir;
    const configPath = join(dir, "models.json");
    await writeFile(
      configPath,
      `{
        "providers": {
          "proxy-gpt": {
            "baseUrl": "https://proxy.example.test/v1",
            "apiKey": "$MIXCODE_TEST_PROXY_KEY",
            "api": "openai-responses",
            "compat": {
              "sendSessionIdHeader": true,
              "supportsLongCacheRetention": true
            },
            "models": [
              {
                "id": "gpt-5.5",
                "name": "GPT-5.5",
                "reasoning": true,
                "contextWindow": 256000,
                "maxTokens": 1,
                "input": ["text", "image"],
                "thinkingLevelMap": {
                  "off": null,
                  "low": "low",
                  "medium": "medium",
                  "high": "high",
                  "xhigh": "xhigh"
                }
              }
            ]
          }
        }
      }`,
      "utf8",
    );

    assert.equal(defaultPiModelsPath(), configPath);
    const bundle = await createPiModelRegistryBundle();
    const source = bundle.sources.find(
      (item) => item.provider === "proxy-gpt" && item.modelId === "gpt-5.5",
    );
    assert.ok(source);
    assert.equal(source.provider, "proxy-gpt");
    assert.equal(source.modelId, "gpt-5.5");
    assert.equal(source.authStatus.source, "environment");
    assert.equal(source.authStatus.label, "MIXCODE_TEST_PROXY_KEY");
    assert.equal(source.model.api, "openai-responses");
    assert.equal(source.model.baseUrl, "https://proxy.example.test/v1");
    assert.equal(source.model.contextWindow, 256000);
    assert.equal(source.model.maxTokens, 1);
    assert.equal(source.model.reasoning, true);
    assert.equal(source.model.thinkingLevelMap?.xhigh, "xhigh");
    assert.deepEqual(source.model.input, ["text", "image"]);
    assert.doesNotMatch(JSON.stringify(source.model), /secret-key/);
    assert.equal(await bundle.runtimeAuth.getApiKey("proxy-gpt"), "secret-key");
    const auth = await bundle.registry.getApiKeyAndHeaders(source.model);
    assert.equal(auth.ok, true);
    if (auth.ok) assert.equal(auth.apiKey, "secret-key");

    registerModels([source.model]);
    assert.equal(
      findModelRef(listAvailableModelRefs(), "proxy-gpt/gpt-5.5").contextWindow,
      256000,
    );
    const runtime = new MixCodeRuntime({
      getApiKey: bundle.runtimeAuth.getApiKey,
      streamFn: bundle.runtimeAuth.stream,
    });
    assert.equal(runtime.resolveModel("proxy-gpt", "gpt-5.5").api, "openai-responses");
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_TEST_PROXY_KEY;
    else process.env.MIXCODE_TEST_PROXY_KEY = oldKey;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});

// Opt-in smoke test target, e.g. MIXCODE_RESPONSES_SMOKE_MODEL="my-provider/my-model".
// Keeps real provider/model names out of the repo while staying runnable locally.
const RESPONSES_SMOKE_MODEL = process.env.MIXCODE_RESPONSES_SMOKE_MODEL ?? "";

test("configured proxy model sends a real OpenAI Responses request", {
  skip: !RESPONSES_SMOKE_MODEL.includes("/")
    ? "set MIXCODE_RESPONSES_SMOKE_MODEL=<provider>/<model-id> to send a real request"
    : false,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-responses-smoke-"));
  try {
    const workdir = join(dir, "repo");
    await mkdir(workdir, { recursive: true });
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
    const bundle = await createPiModelRegistryBundle(undefined, join(agentDir, "auth.json"));
    const slash = RESPONSES_SMOKE_MODEL.indexOf("/");
    const provider = RESPONSES_SMOKE_MODEL.slice(0, slash);
    const modelId = RESPONSES_SMOKE_MODEL.slice(slash + 1);
    const model = bundle.registry.find(provider, modelId);
    assert.ok(model, `${RESPONSES_SMOKE_MODEL} must be registered in Pi models.json`);
    assert.equal(model.api, "openai-responses");
    assert.equal(
      bundle.registry.hasConfiguredAuth(model),
      true,
      `${RESPONSES_SMOKE_MODEL} must have configured auth`,
    );

    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      agentDir,
      authStorage: bundle.authStorage,
      modelRegistry: bundle.registry,
      getApiKey: bundle.runtimeAuth.getApiKey,
      streamFn: bundle.runtimeAuth.stream,
    });
    const tab = createTab(1, "responses-smoke", workdir, {
      model: modelToRef(model),
      contextLimit: model.contextWindow,
      thinkingLevel: "minimal",
    });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt:
        "You are a smoke-test assistant. Reply with exactly MIXCODE_RESPONSES_SMOKE_OK and no extra text.",
      thinkingLevel: "minimal",
      workdir,
      model,
    });

    await runtime.prompt(
      "responses-smoke",
      "Reply with exactly MIXCODE_RESPONSES_SMOKE_OK and no extra text.",
    );

    const chat = runtimeTab.chat.map((line) => `${line.role}:${line.text}`).join("\n");
    assert.match(chat, /assistant:MIXCODE_RESPONSES_SMOKE_OK/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi model defaults follow PI_CODING_AGENT_DIR and runtime auth preserves explicit fallbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-pi-model-defaults-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const faux = registerFauxProvider({
    provider: "mixcode-runtime-fallback",
    api: "mixcode-runtime-fallback-api",
  });
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    assert.equal(defaultPiModelsPath(), join(dir, "models.json"));
    assert.equal(defaultPiAuthPath(), join(dir, "auth.json"));

    faux.setResponses([
      (_context, options) => {
        assert.equal(options?.apiKey, "caller-key");
        assert.equal(options?.headers, undefined);
        return fauxAssistantMessage("ok");
      },
    ]);
    const runtimeAuth = createPiModelRuntimeAuth({
      getApiKeyForProvider: async () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    } as never);
    const streamed = await runtimeAuth.stream(
      faux.getModel(),
      { systemPrompt: "", messages: [], tools: [] },
      { apiKey: "caller-key" },
    );
    assert.equal((await streamed.result()).stopReason, "stop");
  } finally {
    faux.unregister();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi model runtime auth merges request headers and surfaces auth errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-pi-runtime-auth-"));
  const oldKey = process.env.MIXCODE_TEST_API_KEY;
  try {
    process.env.MIXCODE_TEST_API_KEY = "resolved-test-key";
    const configPath = join(dir, "models.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          "mixcode-auth-test": {
            baseUrl: "https://runtime-auth.example/v1",
            api: "mixcode-auth-test-api",
            apiKey: "$MIXCODE_TEST_API_KEY",
            authHeader: true,
            headers: {
              "x-provider": "provider",
              "x-secret": "$MIXCODE_TEST_API_KEY",
            },
            models: [{ id: "auth-model", headers: { "x-model": "model", "x-provider": "model" } }],
          },
        },
      }),
      "utf8",
    );
    const bundle = await createPiModelRegistryBundle(configPath);
    const pendingResponses: Array<
      (context: Context, options?: SimpleStreamOptions) => ReturnType<typeof fauxAssistantMessage>
    > = [];
    const authTestStreamSimple = (requestModel: Model<any>, context: Context, options?: SimpleStreamOptions) => {
        const response = pendingResponses.shift();
        const message = response
          ? response(context, options)
          : fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: `No response for ${requestModel.id}`,
            });
        return streamSingleMessage({
          ...message,
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
        });
      };
    bundle.registry.registerProvider("mixcode-auth-test", {
      api: "mixcode-auth-test-api",
      streamSimple: authTestStreamSimple,
    });
    if (!getApiProvider("mixcode-auth-test-api")) {
      registerApiProvider({
        api: "mixcode-auth-test-api",
        stream: authTestStreamSimple as any,
        streamSimple: authTestStreamSimple as any,
      });
    }
    const model = bundle.registry.find("mixcode-auth-test", "auth-model");
    assert.ok(model);
    const auth = await bundle.registry.getApiKeyAndHeaders(model);
    assert.equal(auth.ok, true);
    if (auth.ok) {
      assert.equal(auth.apiKey, "resolved-test-key");
      assert.equal(auth.headers?.Authorization, "Bearer resolved-test-key");
      assert.equal(auth.headers?.["x-secret"], "resolved-test-key");
      assert.equal(auth.headers?.["x-provider"], "model");
    }

    pendingResponses.push((context, options) => {
      assert.equal(options?.apiKey, "resolved-test-key");
      assert.equal(options?.headers?.Authorization, "Bearer resolved-test-key");
      assert.equal(options?.headers?.["x-provider"], "override");
      assert.equal(options?.headers?.["x-model"], "model");
      assert.equal(options?.headers?.["x-call"], "call");
      return fauxAssistantMessage(`headers:${context.messages.length}`);
    });
    const streamed = await bundle.runtimeAuth.stream(
      model,
      { systemPrompt: "", messages: [], tools: [] },
      { headers: { "x-provider": "override", "x-call": "call" } },
    );
    assert.equal((await streamed.result()).content[0]?.type, "text");

    const missingConfigPath = join(dir, "missing-key-models.json");
    await writeFile(
      missingConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-auth-test": {
            baseUrl: "https://runtime-auth.example/v1",
            api: "mixcode-auth-test-api",
            apiKey: "!printf ''",
            authHeader: true,
            models: [{ id: "auth-model" }],
          },
        },
      }),
      "utf8",
    );
    const missingBundle = await createPiModelRegistryBundle(missingConfigPath);
    const missingModel = missingBundle.registry.find("mixcode-auth-test", "auth-model");
    assert.ok(missingModel);
    await assert.rejects(
      missingBundle.runtimeAuth.stream(missingModel, { systemPrompt: "", messages: [], tools: [] }),
      /Failed to resolve API key/,
    );
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_TEST_API_KEY;
    else process.env.MIXCODE_TEST_API_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});

function streamSingleMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
  });
  return stream;
}

test("pi model registry exposes missing or incomplete config explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-model-config-missing-"));
  const oldConfig = process.env.MIXCODE_MODEL_CONFIG;
  try {
    const missingPath = join(dir, "missing.jsonc");
    assert.equal((await loadPiModelSources(missingPath)).length > 0, true);
    const directoryPath = join(dir, "directory.jsonc");
    await mkdir(directoryPath);
    await assert.rejects(
      loadPiModelSources(directoryPath),
      /EISDIR|illegal operation on a directory/,
    );

    const emptyPath = join(dir, "empty.jsonc");
    await writeFile(emptyPath, `{ "providers": {} }`, "utf8");
    assert.equal((await loadPiModelSources(emptyPath)).length > 0, true);

    const noApiPath = join(dir, "no-api.jsonc");
    await writeFile(
      noApiPath,
      customConfigBody({ baseUrl: "https://no-api.example/v1", api: false }),
      "utf8",
    );
    await assert.rejects(loadPiModelSources(noApiPath), /no "api" specified/);

    const literalPath = join(dir, "literal.jsonc");
    await writeFile(
      literalPath,
      customConfigBody({
        baseUrl: "https://literal.example/v1",
        apiKey: "MIXCODE_TEST_UNSET_API_KEY",
        compat: { sendSessionIdHeader: false },
        input: ["audio"],
      }),
      "utf8",
    );
    process.env.MIXCODE_MODEL_CONFIG = literalPath;
    assert.equal((await loadPiModelSources()).length > 0, true);

    const literalValidPath = join(dir, "literal-valid.jsonc");
    await writeFile(
      literalValidPath,
      customConfigBody({
        baseUrl: "https://literal.example/v1",
        apiKey: "MIXCODE_TEST_UNSET_API_KEY",
        compat: { sendSessionIdHeader: false },
      }),
      "utf8",
    );
    const source = (await loadPiModelSources(literalValidPath)).find(
      (item) => item.provider === "proxy-gpt" && item.modelId === "gpt-5.5",
    );
    assert.ok(source);
    assert.equal(source.model.baseUrl, "https://literal.example/v1");
    assert.equal(source.model.compat?.sendSessionIdHeader, false);
    assert.deepEqual(source.model.input, ["text", "image"]);
    const literalBundle = await createPiModelRegistryBundle(literalValidPath);
    assert.equal(
      await literalBundle.runtimeAuth.getApiKey("proxy-gpt"),
      "MIXCODE_TEST_UNSET_API_KEY",
    );

    const minimalPath = join(dir, "minimal.jsonc");
    await writeFile(
      minimalPath,
      customConfigBody({ baseUrl: "https://minimal.example/v1", minimal: true }),
      "utf8",
    );
    const minimal = (await loadPiModelSources(minimalPath)).find(
      (item) => item.provider === "proxy-gpt" && item.modelId === "gpt-5.5",
    );
    assert.ok(minimal);
    assert.equal(minimal.model.name, "gpt-5.5");
    assert.equal(minimal.model.reasoning, false);
    assert.deepEqual(minimal.model.input, ["text"]);
    assert.equal(minimal.model.contextWindow, 128000);
    assert.equal(minimal.model.maxTokens, 16384);
    assert.equal(minimal.model.thinkingLevelMap, undefined);

    const missingBasePath = join(dir, "missing-base.jsonc");
    await writeFile(missingBasePath, customConfigBody({ baseUrl: undefined }), "utf8");
    await assert.rejects(loadPiModelSources(missingBasePath), /"baseUrl" is required/);
  } finally {
    if (oldConfig === undefined) delete process.env.MIXCODE_MODEL_CONFIG;
    else process.env.MIXCODE_MODEL_CONFIG = oldConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi model registry follows models.json overrides and edge cases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-pi-models-edges-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldApiKey = process.env.MIXCODE_TEST_API_KEY;
  try {
    process.env.MIXCODE_TEST_API_KEY = "resolved-test-key";
    const scalarPath = join(dir, "scalar.json");
    await writeFile(scalarPath, "[]", "utf8");
    await assert.rejects(loadPiModelSources(scalarPath), /Invalid models\.json schema/);
    const noProvidersPath = join(dir, "no-providers.json");
    await writeFile(noProvidersPath, "{}", "utf8");
    await assert.rejects(loadPiModelSources(noProvidersPath), /Invalid models\.json schema/);

    const ignoredPath = join(dir, "ignored.json");
    await writeFile(
      ignoredPath,
      JSON.stringify({
        providers: {
          ignored: "bad",
          empty: { models: [] },
          nonArray: { models: "bad" },
          mixed: {
            baseUrl: "https://mixed.example/v1",
            api: "openai-responses",
            apiKey: "$MIXCODE_TEST_API_KEY",
            models: ["bad"],
          },
        },
      }),
      "utf8",
    );
    await assert.rejects(loadPiModelSources(ignoredPath), /Invalid models\.json schema/);

    const pathFromHome = join(process.env.HOME ?? "", ".pi", "agent", "models.json");
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(defaultPiModelsPath(), pathFromHome);
    process.env.PI_CODING_AGENT_DIR = "~";
    assert.equal(defaultPiModelsPath(), join(process.env.HOME ?? "", "models.json"));
    process.env.PI_CODING_AGENT_DIR = "~/pi-agent-test";
    assert.equal(
      defaultPiModelsPath(),
      join(process.env.HOME ?? "", "pi-agent-test", "models.json"),
    );

    const missingIdPath = join(dir, "missing-id.json");
    await writeFile(
      missingIdPath,
      JSON.stringify({
        providers: {
          demo: { baseUrl: "https://demo.example/v1", api: "openai-responses", models: [{}] },
        },
      }),
      "utf8",
    );
    await assert.rejects(loadPiModelSources(missingIdPath), /Invalid models\.json schema/);

    const configPath = join(dir, "models.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          "proxy-gpt": {
            baseUrl: "https://provider.example/v1",
            api: "openai-responses",
            apiKey: "$MIXCODE_TEST_API_KEY",
            compat: { sendSessionIdHeader: true },
            models: [
              {
                id: "gpt-5.5",
                api: "anthropic-messages",
                baseUrl: "https://model.example/v1",
                name: "GPT-5.5 Override",
                reasoning: true,
                input: ["image"],
                cost: { input: 1, output: 0, cacheRead: 2, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 9,
                compat: { supportsLongCacheRetention: true },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const bundle = await createPiModelRegistryBundle(configPath);
    const source = bundle.sources.find(
      (item) => item.provider === "proxy-gpt" && item.modelId === "gpt-5.5",
    );
    assert.ok(source);
    assert.equal(source.authStatus.source, "environment");
    assert.equal(await bundle.runtimeAuth.getApiKey("proxy-gpt"), "resolved-test-key");
    assert.equal(await bundle.runtimeAuth.getApiKey("missing"), undefined);
    assert.equal(source.model.name, "GPT-5.5 Override");
    assert.equal(source.model.api, "anthropic-messages");
    assert.equal(source.model.baseUrl, "https://model.example/v1");
    assert.equal(source.model.reasoning, true);
    assert.deepEqual(source.model.input, ["image"]);
    assert.equal(source.model.cost.input, 1);
    assert.equal(source.model.cost.output, 0);
    assert.equal(source.model.cost.cacheRead, 2);
    assert.equal(source.model.cost.cacheWrite, 0);
    assert.equal(source.model.contextWindow, 256000);
    assert.equal(source.model.maxTokens, 9);
    assert.equal(source.model.compat?.sendSessionIdHeader, true);
    assert.equal(source.model.compat?.supportsLongCacheRetention, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldApiKey === undefined) delete process.env.MIXCODE_TEST_API_KEY;
    else process.env.MIXCODE_TEST_API_KEY = oldApiKey;
    await rm(dir, { recursive: true, force: true });
  }
});

function customConfigBody(options: {
  baseUrl?: string;
  api?: string | false;
  apiKey?: string;
  compat?: Record<string, unknown>;
  input?: unknown[];
  minimal?: boolean;
}): string {
  const baseUrlLine = options.baseUrl === undefined ? "" : `"baseUrl": "${options.baseUrl}",`;
  const apiLine = options.api === false ? "" : `"api": "${options.api ?? "openai-responses"}",`;
  const compatLine = options.compat ? `"compat": ${JSON.stringify(options.compat)},` : "";
  const input = JSON.stringify(options.input ?? ["text", "image"]);
  const nameLine = options.minimal ? "" : `"name": "GPT-5.5",`;
  const reasoningLine = options.minimal ? "" : `"reasoning": true,`;
  const limitLine = options.minimal ? "" : `"contextWindow": 256000, "maxTokens": 1,`;
  const inputLine = options.minimal ? "" : `"input": ${input},`;
  const thinkingLine = options.minimal ? "" : `"thinkingLevelMap": { "off": null, "low": "low" },`;
  return `{
    "providers": {
      "proxy-gpt": {
        ${baseUrlLine}
        ${apiLine}
        ${compatLine}
        "apiKey": "${options.apiKey ?? "MIXCODE_TEST_PROXY_KEY"}",
        "models": [
          {
            "id": "gpt-5.5",
            ${nameLine}
            ${reasoningLine}
            ${limitLine}
            ${inputLine}
            ${thinkingLine}
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }`;
}

test("runtime.reloadModelConfig re-reads models.json from disk after it changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-reload-models-"));
  const oldKey = process.env.MIXCODE_RELOAD_KEY;
  try {
    process.env.MIXCODE_RELOAD_KEY = "reload-secret";
    const configPath = join(dir, "models.json");
    const provider = (modelId: string) => ({
      providers: {
        "reload-proxy": {
          baseUrl: "https://reload.example/v1",
          api: "openai",
          apiKey: "MIXCODE_RELOAD_KEY",
          models: [{ id: modelId, contextWindow: 4096 }],
        },
      },
    });
    await writeFile(configPath, JSON.stringify(provider("alpha")), "utf8");
    const bundle = await createPiModelRegistryBundle(configPath);
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      agentDir: dir,
      authStorage: bundle.authStorage,
      modelRegistry: bundle.registry,
      getApiKey: bundle.runtimeAuth.getApiKey,
      streamFn: bundle.runtimeAuth.stream,
    });
    assert.equal(runtime.resolveModel("reload-proxy", "alpha").id, "alpha");

    // Replace the model on disk; before reload the registry still serves the old one.
    await writeFile(configPath, JSON.stringify(provider("beta")), "utf8");
    const configured = runtime.reloadModelConfig();

    assert.ok(
      configured.some((ref) => ref.provider === "reload-proxy" && ref.modelId === "beta"),
      "reloaded config should expose the new beta model",
    );
    assert.ok(
      !configured.some((ref) => ref.modelId === "alpha"),
      "the removed alpha model should no longer be configured",
    );
    assert.equal(runtime.resolveModel("reload-proxy", "beta").id, "beta");
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_RELOAD_KEY;
    else process.env.MIXCODE_RELOAD_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});
