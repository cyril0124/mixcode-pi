import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, type ProviderAuth } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAuxModelRegistry } from "../../test/helpers/aux-model-registry.js";
import { runAutoRename } from "./index.js";

const modelRef = { provider: "rename-native-test", id: "local" };

async function renameFixture(t: TestContext, auth: ProviderAuth) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aux-rename-registry-"));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  const requests: Array<{ baseUrl: string; apiKey?: string; headers?: unknown; env?: unknown }> =
    [];
  const { registry } = await createAuxModelRegistry({
    models: [modelRef],
    auth,
    complete: async (model, _context, options) => {
      requests.push({
        baseUrl: model.baseUrl,
        apiKey: options?.apiKey,
        headers: options?.headers,
        env: options?.env,
      });
      return fauxAssistantMessage("native-provider-title");
    },
  });
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Fix request routing", timestamp: 1 });
  const names: string[] = [];
  const notices: string[] = [];
  const ctx = {
    model: registry.find(modelRef.provider, modelRef.id),
    modelRegistry: registry,
    sessionManager: session,
    hasUI: false,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  const run = () =>
    runAutoRename({
      ctx,
      getThinkingLevel: () => "off",
      setSessionName: (name) => names.push(name),
      agentDir,
    });
  return { requests, names, notices, run };
}

test("auto-rename uses configured native providers with keyless authentication", async (t) => {
  const fixture = await renameFixture(t, {
    apiKey: { name: "Local", resolve: async () => ({ auth: {} }) },
  });
  assert.deepEqual(await fixture.run(), { ok: true, title: "native-provider-title" });
  assert.deepEqual(fixture.names, ["native-provider-title"]);
  assert.equal(fixture.requests.length, 1);
});

test("auto-rename applies provider-auth endpoint, headers and environment", async (t) => {
  const fixture = await renameFixture(t, {
    apiKey: {
      name: "Resolved request",
      resolve: async () => ({
        auth: {
          apiKey: "resolved-key",
          baseUrl: "https://resolved.invalid/v1",
          headers: { "X-Resolved": "yes", "X-Removed": null },
        },
        env: { AUX_TEST_ENV: "scoped" },
      }),
    },
  });
  assert.deepEqual(await fixture.run(), { ok: true, title: "native-provider-title" });
  assert.deepEqual(fixture.requests, [
    {
      baseUrl: "https://resolved.invalid/v1",
      apiKey: "resolved-key",
      headers: { "X-Resolved": "yes", "X-Removed": null },
      env: { AUX_TEST_ENV: "scoped" },
    },
  ]);
});

test("auto-rename surfaces registry authentication failures without renaming", async (t) => {
  const fixture = await renameFixture(t, {
    apiKey: {
      name: "Unavailable",
      resolve: async () => {
        throw new Error("Credential store unavailable");
      },
    },
  });
  const result = await fixture.run();
  assert.equal(result.ok, false);
  assert.deepEqual(fixture.names, []);
  assert.deepEqual(fixture.requests, []);
  assert.ok(fixture.notices.some((message) => message.includes("Credential store unavailable")));
});

test("auto-rename format retries resolve fresh request authentication", async (t) => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aux-rename-retry-"));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  let resolutions = 0;
  const keys: Array<string | undefined> = [];
  const { registry } = await createAuxModelRegistry({
    models: [modelRef],
    auth: {
      apiKey: {
        name: "Rotating test authentication",
        check: async () => ({ type: "api_key" }),
        resolve: async () => ({ auth: { apiKey: `key-${++resolutions}` } }),
      },
    },
    complete: async (_model, _context, options) => {
      keys.push(options?.apiKey);
      return fauxAssistantMessage(keys.length === 1 ? "123-456" : "valid-retry-title");
    },
  });
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Rename the session", timestamp: 1 });
  const titles: string[] = [];
  const result = await runAutoRename({
    agentDir,
    getThinkingLevel: () => "off",
    setSessionName: (title) => titles.push(title),
    ctx: {
      model: registry.find(modelRef.provider, modelRef.id),
      modelRegistry: registry,
      sessionManager: session,
      hasUI: false,
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext,
  });
  assert.deepEqual(result, { ok: true, title: "valid-retry-title" });
  assert.deepEqual(keys, ["key-1", "key-2"]);
  assert.deepEqual(titles, ["valid-retry-title"]);
});
