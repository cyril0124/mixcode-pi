import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTab, MixCodeRuntime } from "./helpers/mixcode.js";

/**
 * Per-tab services build their own on-disk SettingsManager (createRuntimeServices),
 * so `defaultTools` has to be written to <agentDir>/settings.json to reach a session.
 */
async function activeToolNamesFor(
  defaultTools: string[] | undefined,
  extensionFactories: ExtensionFactory[] = [],
): Promise<string[]> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-default-tools-"));
  try {
    const agentDir = path.join(dir, "agent");
    await fsPromises.mkdir(agentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify(defaultTools ? { packages: [], defaultTools } : { packages: [] }),
      "utf8",
    );
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      extensionFactories,
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    return runtimeTab.agentSession.getActiveToolNames().slice().sort();
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

test("unset defaultTools keeps pi's built-in default active set", async () => {
  assert.deepEqual(await activeToolNamesFor(undefined), ["bash", "edit", "read", "write"]);
});

test("defaultTools narrows the active built-in set", async () => {
  // MixCode's own tool activation must not re-expand the configured list.
  assert.deepEqual(await activeToolNamesFor(["read", "ls"]), ["ls", "read"]);
});

test("defaultTools: [] starts a session with no built-in tools active", async () => {
  assert.deepEqual(await activeToolNamesFor([]), []);
});

test("defaultTools leaves an extension tool that shadows a built-in name active", async () => {
  // Pi's rule: extension-owned tools stay active whatever `defaultTools` says.
  const extensionGrep: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "grep",
      label: "Extension grep",
      description: "extension-owned grep",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "hit" }], details: {} }),
    });
  };
  assert.deepEqual(await activeToolNamesFor(["read"], [extensionGrep]), ["grep", "read"]);
});
