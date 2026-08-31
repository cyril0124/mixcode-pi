import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ExtensionSelectorComponent,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { MixCodeRuntime, createInitialState, createTab } from "./helpers/mixcode.js";
import { activateTab } from "../src/core/tabs.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { loginArgumentCompletions, openPiLogin, openPiLogout } from "../src/ui/pi-auth.js";
import type { AuthInputHost } from "../src/ui/app-types.js";

async function offlineModelRuntime(): Promise<ModelRuntime> {
  return await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

function dualAuthModelRuntime(): ModelRuntime {
  return {
    getProviders: () => [
      {
        id: "dual",
        name: "Dual Provider",
        auth: {
          oauth: { name: "Dual account", loginLabel: "Sign in to Dual" },
          apiKey: { name: "Dual API key", login: async () => ({ type: "api_key" }) },
        },
      },
    ],
    getProviderAuthStatus: () => ({ configured: false }),
    isUsingOAuth: () => false,
  } as unknown as ModelRuntime;
}

function capturingInputHost(): {
  host: AuthInputHost;
  current: () => Component | undefined;
} {
  let component: Component | undefined;
  return {
    host: {
      setInputComponent: (next) => {
        component = next;
      },
      clearInputComponent: () => {
        component = undefined;
      },
      requestRender: () => undefined,
    },
    current: () => component,
  };
}

test("openPiLogin starts with Pi's authentication-type selector", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const modelRuntime = dualAuthModelRuntime();
  const input = capturingInputHost();

  const login = openPiLogin(
    state,
    testRuntime({ getSharedModelRuntime: () => modelRuntime }),
    input.host,
  );
  const selector = input.current();
  assert.ok(selector instanceof ExtensionSelectorComponent);
  selector.handleInput("\x1b");
  await login;
});

test("openPiLogin asks for an auth type when an exact provider supports both", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const modelRuntime = dualAuthModelRuntime();
  const input = capturingInputHost();

  const login = openPiLogin(
    state,
    testRuntime({ getSharedModelRuntime: () => modelRuntime }),
    input.host,
    "DUAL",
  );
  const selector = input.current();
  assert.ok(selector instanceof ExtensionSelectorComponent);
  selector.handleInput("\x1b");
  await login;
});

test("loginArgumentCompletions deduplicates provider auth methods", () => {
  assert.deepEqual(loginArgumentCompletions(dualAuthModelRuntime(), "dual"), [
    {
      value: "dual",
      label: "dual",
      description: "Dual Provider · subscription/API key",
    },
  ]);
});

test("MixCodeRuntime shares the provided ModelRuntime across tabs", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-auth-shared-"));
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(modelRuntime);

    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
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

    assert.equal(runtime.getSharedModelRuntime(), modelRuntime);
    assert.equal(tab1.services.modelRuntime, modelRuntime);
    assert.equal(tab2.services.modelRuntime, modelRuntime);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("openPiLogin surfaces missing runtime and missing input host as toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));

  await openPiLogin(state, testRuntime({ getSharedModelRuntime: () => undefined }), undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth not available \(no model runtime\)/);

  const modelRuntime = await offlineModelRuntime();
  const runtime = testRuntime({ getSharedModelRuntime: () => modelRuntime });
  await openPiLogin(state, runtime, undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth UI not available/);
});

test("openPiLogin routes its toast to the active tab, and is a no-op with zero tabs", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  activateTab(state, "s2");

  const noRuntime = testRuntime({ getSharedModelRuntime: () => undefined });
  await openPiLogin(state, noRuntime, undefined);
  assert.equal(state.tabs[1]?.toast?.type, "error");
  assert.equal(state.tabs[0]?.toast, undefined, "toast must not land on the first tab");

  // /login is reachable from Home with no agent tab open; there is no toast surface then.
  const empty = createInitialState("/repo");
  await openPiLogin(empty, noRuntime, undefined);
  await openPiLogout(empty, noRuntime, undefined);
  assert.equal(empty.tabs.length, 0);
});

test("openPiLogout surfaces missing runtime and missing input host as toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));

  await openPiLogout(state, testRuntime({ getSharedModelRuntime: () => undefined }), undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth not available \(no model runtime\)/);

  const modelRuntime = await offlineModelRuntime();
  const runtime = testRuntime({ getSharedModelRuntime: () => modelRuntime });
  await openPiLogout(state, runtime, undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth UI not available/);
});
