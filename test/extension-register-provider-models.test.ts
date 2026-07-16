import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "../src/index.js";
import type { MixCodeModelRef } from "../src/core/types.js";

test("extension registerProvider notifies onModelsChanged with selectable model refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-ext-provider-"));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const seen: MixCodeModelRef[][] = [];

  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", () => {
      pi.registerProvider("ext-proxy", {
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
        api: "openai-completions",
        models: [
          {
            id: "ext-model",
            name: "Ext Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_000,
            maxTokens: 1_024,
          },
        ],
      });
    });
  };

  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      modelRuntime,
      modelRegistry,
      extensionFactories: [extension],
    });
    runtime.onModelsChanged((refs) => {
      seen.push(refs);
    });

    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
    });

    assert.ok(seen.length > 0, "expected onModelsChanged after extension registerProvider");
    const flat = seen.flat();
    assert.ok(
      flat.some((ref) => ref.provider === "ext-proxy" && ref.modelId === "ext-model"),
      `expected ext-proxy/ext-model in notifications, got ${JSON.stringify(flat)}`,
    );

    // Selectable list API used by UI rebuild.
    const selectable = runtime.collectSelectableModelRefs();
    assert.ok(
      selectable.some((ref) => ref.provider === "ext-proxy" && ref.modelId === "ext-model"),
      "collectSelectableModelRefs should include extension provider model",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
