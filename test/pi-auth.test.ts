import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createInitialState, createTab } from "../src/index.js";
import { openPiLogin, openPiLogout } from "../src/ui/pi-auth.js";

test("MixCodeRuntime shares the provided ModelRuntime across tabs", async () => {
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

    assert.equal(runtime.getSharedModelRuntime(), modelRuntime);
    assert.equal(tab1.services.modelRuntime, modelRuntime);
    assert.equal(tab2.services.modelRuntime, modelRuntime);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openPiLogin surfaces missing runtime and missing input host as toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));

  await openPiLogin(state, { getSharedModelRuntime: () => undefined }, undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth not available \(no model runtime\)/);

  const runtime = {
    getSharedModelRuntime: () => ({}) as never,
  };
  await openPiLogin(state, runtime, undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth UI not available/);
});

test("openPiLogout surfaces missing runtime and missing input host as toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));

  await openPiLogout(state, { getSharedModelRuntime: () => undefined }, undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth not available \(no model runtime\)/);

  const runtime = {
    getSharedModelRuntime: () => ({}) as never,
  };
  await openPiLogout(state, runtime, undefined);
  assert.equal(state.tabs[0]?.toast?.type, "error");
  assert.match(state.tabs[0]?.toast?.message ?? "", /Auth UI not available/);
});
