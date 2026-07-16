import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "../src/index.js";

test("ModelRuntime is shared across tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-shared-"));
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(modelRuntime);

    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      modelRuntime,
      modelRegistry: registry,
    });

    const tab1 = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const tab2 = await runtime.createTab(createTab(2, "s2", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.equal(tab1.services.modelRuntime, tab2.services.modelRuntime);
    assert.equal(tab1.services.modelRuntime, modelRuntime);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ModelRuntime stores and logs out API keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-apikey-"));
  try {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });

    await credentials.modify("test-provider", async () => ({
      type: "api_key",
      key: "test-key-123",
    }));
    const stored = await credentials.read("test-provider");
    assert.equal(stored?.type, "api_key");
    assert.equal(stored && "key" in stored ? stored.key : undefined, "test-key-123");

    await modelRuntime.logout("test-provider");
    const afterLogout = await credentials.read("test-provider");
    assert.equal(afterLogout, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ModelRuntime refresh updates provider auth status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-status-"));
  try {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(modelRuntime);

    const beforeStatus = registry.getProviderAuthStatus("anthropic");
    assert.equal(beforeStatus.configured, false);

    await credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "sk-ant-test",
    }));
    await registry.refresh();

    const afterStatus = registry.getProviderAuthStatus("anthropic");
    assert.equal(afterStatus.configured, true);
    assert.equal(afterStatus.source, "stored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("login provider list includes built-in OAuth providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-oauth-"));
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });

    const oauthProviders = modelRuntime
      .getProviders()
      .filter((provider) => provider.auth.oauth?.login);
    assert.ok(oauthProviders.length > 0);

    const hasAnthropicOrOpenAI = oauthProviders.some(
      (provider) => provider.id === "anthropic" || provider.id === "openai" || provider.id === "openai-codex",
    );
    assert.ok(hasAnthropicOrOpenAI, "Expected at least one major OAuth provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
