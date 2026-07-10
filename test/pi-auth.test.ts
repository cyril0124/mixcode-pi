import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "../src/index.js";

test("AuthStorage and ModelRegistry are shared across tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-shared-"));
  try {
    const authPath = join(dir, "auth.json");
    const authStorage = AuthStorage.create(authPath);
    const registry = new ModelRegistry(authStorage);

    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      authStorage,
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

    // Both tabs use the same registry
    assert.equal(tab1.services.modelRegistry, tab2.services.modelRegistry);
    assert.equal(tab1.services.modelRegistry.authStorage, authStorage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AuthStorage set/logout works for API key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-apikey-"));
  try {
    const authPath = join(dir, "auth.json");
    const authStorage = AuthStorage.create(authPath);

    authStorage.set("test-provider", { type: "api_key", key: "test-key-123" });
    const retrieved = await authStorage.getApiKey("test-provider");
    assert.equal(retrieved, "test-key-123");

    authStorage.logout("test-provider");
    const afterLogout = await authStorage.getApiKey("test-provider");
    assert.equal(afterLogout, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ModelRegistry refresh updates provider auth status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-status-"));
  try {
    const authPath = join(dir, "auth.json");
    const authStorage = AuthStorage.create(authPath);
    const registry = new ModelRegistry(authStorage);

    const beforeStatus = registry.getProviderAuthStatus("anthropic");
    assert.equal(beforeStatus.configured, false);

    authStorage.set("anthropic", { type: "api_key", key: "sk-ant-test" });
    registry.refresh();

    const afterStatus = registry.getProviderAuthStatus("anthropic");
    assert.equal(afterStatus.configured, true);
    assert.equal(afterStatus.source, "stored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OAuth provider list includes built-in providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-auth-oauth-"));
  try {
    const authPath = join(dir, "auth.json");
    const authStorage = AuthStorage.create(authPath);

    const oauthProviders = authStorage.getOAuthProviders();
    assert.ok(oauthProviders.length > 0);

    const hasAnthropicOrOpenAI = oauthProviders.some(
      (p) => p.id === "anthropic" || p.id === "openai",
    );
    assert.ok(hasAnthropicOrOpenAI, "Expected at least one major OAuth provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
