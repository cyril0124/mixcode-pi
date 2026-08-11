import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createTab } from "../src/core/defaults.js";

test("host hasSessionOnDisk and previewSessionImport need no live tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-host-disk-"));
  const sessionsRoot = path.join(dir, "sessions");
  const workdir = path.join(dir, "wd");
  await fsPromises.mkdir(sessionsRoot, { recursive: true });
  await fsPromises.mkdir(workdir, { recursive: true });

  const runtime = new MixCodeRuntime({ sessionsRoot });
  assert.equal(runtime.hasSessionOnDisk("s1"), false);
  // Filename form used by findSessionFileByName: <prefix>_<sessionId>.jsonl
  await fsPromises.writeFile(path.join(sessionsRoot, "x_s1.jsonl"), "{}\n", "utf8");
  assert.equal(runtime.hasSessionOnDisk("s1"), true);

  const importPath = path.join(dir, "import.jsonl");
  await fsPromises.writeFile(
    importPath,
    `${JSON.stringify({ type: "session", id: "imported-1", cwd: workdir })}\n`,
    "utf8",
  );
  const preview = await runtime.previewSessionImport(importPath, undefined, workdir);
  assert.equal(preview.sessionId, "imported-1");
  assert.equal(preview.resolvedPath, importPath);
});

test("host rebuildChatFromSession / clearTabChatProjection / showHiddenMessages", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-host-chat-"));
  const sessionsRoot = path.join(dir, "sessions");
  const workdir = path.join(dir, "wd");
  await fsPromises.mkdir(workdir, { recursive: true });
  const runtime = new MixCodeRuntime({ sessionsRoot });
  try {
    const tab = createTab(1, "s1", workdir);
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir,
    });

    runtimeTab.chat.push({
      role: "system",
      title: "status",
      text: "ephemeral",
    } as never);
    runtime.clearTabChatProjection("s1");
    assert.deepEqual(runtimeTab.chat, []);

    const originalGetBranch = runtimeTab.session.getBranch.bind(runtimeTab.session);
    runtimeTab.session.getBranch = () =>
      [
        {
          type: "custom_message",
          id: "e1",
          customType: "note",
          content: "hidden note",
          display: false,
          timestamp: new Date().toISOString(),
        },
      ] as never;

    runtime.rebuildChatFromSession("s1");
    assert.equal(runtimeTab.chat.length, 0);

    runtimeTab.showHiddenMessages = true;
    runtime.rebuildChatFromSession("s1");
    assert.equal(runtimeTab.chat.length, 1);
    assert.equal(runtimeTab.chat[0]?.title, "extension note [hidden]");

    runtimeTab.session.getBranch = originalGetBranch;
  } finally {
    await runtime.closeAllTabs().catch(() => undefined);
  }
});
