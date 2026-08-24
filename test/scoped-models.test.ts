import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { configureDisabledModelRuntime, createTab, MixCodeRuntime } from "./helpers/mixcode.js";

async function policyRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const { provider: blocked } = fauxProvider({
    provider: "blocked-provider",
    models: [{ id: "blocked-model", name: "Blocked Model" }],
  });
  const { provider: allowed } = fauxProvider({
    provider: "allowed-provider",
    models: [
      { id: "allowed-model", name: "Allowed Model" },
      { id: "blocked-model", name: "Individually Blocked Model" },
    ],
  });
  runtime.registerNativeProvider(blocked);
  runtime.registerNativeProvider(allowed);
  await runtime.setRuntimeApiKey("blocked-provider", "test-key");
  await runtime.setRuntimeApiKey("allowed-provider", "test-key");
  await runtime.getAvailable();
  return runtime;
}

/** Capture what an extension sees on ctx.scopedModels at session_start. */
function scopeCapturingExtension(seen: string[][]): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      seen.push(ctx.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`));
    });
  };
}

async function scopeSeenByExtension(
  configure: (runtime: ModelRuntime) => void,
): Promise<string[]> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-scoped-models-"));
  try {
    const modelRuntime = await policyRuntime();
    configure(modelRuntime);
    const seen: string[][] = [];
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: path.join(dir, "agent"),
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      extensionFactories: [scopeCapturingExtension(seen)],
    });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.equal(seen.length, 1, "extension should observe exactly one session_start");
    // Ambient credentials in the environment can add unrelated providers; the
    // denylist contract only concerns the fixture providers.
    return seen[0]!
      .filter((id) => id.startsWith("blocked-provider/") || id.startsWith("allowed-provider/"))
      .sort();
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

test("extensions see MixCode's model denylist as the session scope", async () => {
  const scope = await scopeSeenByExtension((runtime) => {
    configureDisabledModelRuntime(
      runtime,
      ["blocked-provider"],
      ["allowed-provider/blocked-model"],
    );
  });
  assert.deepEqual(scope, ["allowed-provider/allowed-model"]);
});

test("a denylist reload re-publishes the scope to a live session", async () => {
  const seen: string[][] = [];
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-rescope-"));
  try {
    const modelRuntime = await policyRuntime();
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: path.join(dir, "agent"),
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      extensionFactories: [scopeCapturingExtension(seen)],
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const scopeOf = () =>
      runtimeTab.agentSession.scopedModels.map(
        (scoped) => `${scoped.model.provider}/${scoped.model.id}`,
      );
    assert.deepEqual(scopeOf(), []);

    configureDisabledModelRuntime(modelRuntime, ["blocked-provider"], []);
    runtime.refreshScopedModels();

    const scope = scopeOf();
    assert.equal(scope.includes("blocked-provider/blocked-model"), false);
    assert.ok(scope.includes("allowed-provider/allowed-model"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("no disabled models means an unscoped session (pi: empty scopedModels)", async () => {
  const seen: string[][] = [];
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-unscoped-models-"));
  try {
    const modelRuntime = await policyRuntime();
    configureDisabledModelRuntime(modelRuntime, [], []);
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: path.join(dir, "agent"),
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      extensionFactories: [scopeCapturingExtension(seen)],
    });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.deepEqual(seen, [[]]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
