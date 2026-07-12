import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTab, MixCodeRuntime } from "../src/index.js";

const GUIDELINE = "Always call frobnicate before defrobbing.";

function guidelineToolExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "frobnicate",
      label: "Frobnicate",
      description: "A tool with a distinctive prompt guideline",
      parameters: Type.Object({}),
      promptSnippet: "run frobnicate",
      promptGuidelines: [GUIDELINE],
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  };
}

async function createRuntimeTab() {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-prompt-rebuild-"));
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories: [guidelineToolExtension()],
  });
  const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  return { dir, runtime, runtimeTab };
}

test("MixCode system prompt includes active tool promptGuidelines", async () => {
  const { dir, runtimeTab } = await createRuntimeTab();
  try {
    // Builtin read/edit/write guidelines are Pi-provided and must survive.
    assert.match(
      runtimeTab.agent.state.systemPrompt,
      /Use read to examine files instead of cat or sed\./,
    );
    // Extension-provided guideline for the active custom tool must be present.
    assert.match(runtimeTab.agent.state.systemPrompt, new RegExp(GUIDELINE.replace(/\./g, "\\.")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi-triggered setActiveTools rebuild keeps the MixCode system prompt", async () => {
  const { dir, runtimeTab } = await createRuntimeTab();
  try {
    // MixCode's builder never emits Pi's default "Pi documentation" block.
    assert.doesNotMatch(runtimeTab.agent.state.systemPrompt, /Pi documentation/);

    // Simulate an extension calling pi.setActiveTools() at runtime, which makes
    // Pi rebuild the base system prompt via its own builder.
    runtimeTab.agentSession.setActiveToolsByName(
      runtimeTab.agentSession.getActiveToolNames(),
    );

    // After the rebuild the live prompt must still be MixCode's, not Pi's default.
    assert.doesNotMatch(runtimeTab.agent.state.systemPrompt, /Pi documentation/);
    assert.match(runtimeTab.agent.state.systemPrompt, new RegExp(GUIDELINE.replace(/\./g, "\\.")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
