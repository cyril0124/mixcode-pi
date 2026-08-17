import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { isLocalCommand } from "../src/core/commands.js";
import { createTab } from "../src/core/defaults.js";

test("reset is a registered local command", () => {
  assert.equal(isLocalCommand("reset"), true);
});

test("resetTabToRoot keeps session file and id, clears leaf and chat", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-reset-"));
  const sessionsRoot = path.join(dir, "sessions");
  const workdir = path.join(dir, "wd");
  await fsPromises.mkdir(workdir, { recursive: true });
  const runtime = new MixCodeRuntime({ sessionsRoot });
  try {
    const tab = createTab(1, "s1", workdir, { title: "Keep-My-Title" });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir,
    });
    const sessionFile = runtimeTab.session.getSessionFile();
    assert.ok(sessionFile);

    runtimeTab.session.appendMessage({
      role: "user",
      content: "hello before reset",
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
    } as never);
    assert.notEqual(runtimeTab.session.getLeafId(), null);
    runtime.rebuildChatFromSession("s1");
    assert.ok(runtimeTab.chat.length > 0);

    const first = runtime.resetTabToRoot("s1");
    assert.equal(first.noop, false);
    assert.equal(runtimeTab.session.getSessionId(), "s1");
    assert.equal(runtimeTab.session.getSessionFile(), sessionFile);
    assert.equal(runtimeTab.tab.title, "Keep-My-Title");
    assert.equal(runtimeTab.session.getLeafId(), null);
    assert.deepEqual(runtimeTab.agentSession.agent.state.messages, []);
    assert.equal(runtimeTab.chat.length, 0);
    // Entries remain on disk/tree; only the leaf moved.
    assert.ok(runtimeTab.session.getEntries().length >= 2);

    const second = runtime.resetTabToRoot("s1");
    assert.equal(second.noop, true);
    assert.equal(runtimeTab.session.getSessionId(), "s1");
    assert.equal(runtimeTab.session.getSessionFile(), sessionFile);
  } finally {
    await runtime.closeAllTabs().catch(() => undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
