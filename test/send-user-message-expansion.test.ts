import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTab, MixCodeRuntime } from "./helpers/mixcode.js";

/**
 * mpi-loop delivers scheduled prompts through pi.sendUserMessage(..., {
 * expandPromptTemplates: true }). This checks the option really dispatches a
 * slash command inside a MixCode session, which is what `/loop 5m /cmd` needs.
 */
function commandRegisteringExtension(name: string, calls: string[]): ExtensionFactory {
  return (pi) => {
    pi.registerCommand(name, {
      description: `test ${name}`,
      handler: async (args: string) => {
        calls.push(args);
      },
    });
  };
}

async function withTab(
  calls: string[],
  run: (agentSession: {
    sendUserMessage: (
      content: string,
      options?: { expandPromptTemplates?: boolean },
    ) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-send-user-message-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: path.join(dir, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      extensionFactories: [commandRegisteringExtension("loop-target", calls)],
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await run(runtimeTab.agentSession);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

test("expandPromptTemplates dispatches a slash command instead of sending it as text", async () => {
  const calls: string[] = [];
  await withTab(calls, async (agentSession) => {
    await agentSession.sendUserMessage("/loop-target now", { expandPromptTemplates: true });
  });
  assert.deepEqual(calls, ["now"]);
});
