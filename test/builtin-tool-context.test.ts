import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTab, MixCodeRuntime } from "../src/index.js";

function textFromToolResult(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

test("builtin bash keeps ExtensionContext after MixCode tool activation", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-builtin-tool-ctx-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: path.join(dir, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [] }),
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const bash = runtimeTab.agentSession.agent.state.tools.find((tool) => tool.name === "bash");
    assert.ok(bash, "bash tool should stay active");

    // Contract: pi bash injects PI_SESSION_ID only when execute receives ExtensionContext.
    // activateMixCodeTools used to re-create bare createBashTool() and drop that ctx.
    const result = await bash.execute(
      "builtin-ctx-check",
      { command: 'printf %s "$PI_SESSION_ID"' },
      undefined,
      undefined,
    );
    const sessionId = runtimeTab.session.getSessionId();
    assert.equal(textFromToolResult(result), sessionId);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
