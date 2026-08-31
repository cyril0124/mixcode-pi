import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import extension from "./index.js";
import { writeTranscriptConfig } from "./config.js";

function createEditorScript(marker: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
for arg do file="$arg"; done
printf called > "${marker}"
printf '%s' "$file" >> "${marker}"
`;
}

test("transcript auto mode opens nvim before vim through the command handler", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-transcript-editor-e2e-"));
  const bin = path.join(root, "bin");
  const agentDir = path.join(root, "agent");
  await fs.mkdir(bin, { recursive: true });
  const nvimMarker = path.join(root, "nvim.marker");
  const vimMarker = path.join(root, "vim.marker");
  const sessionFile = path.join(root, "sessions", "session-123.jsonl");
  await fs.writeFile(path.join(bin, "nvim"), createEditorScript(nvimMarker), { mode: 0o755 });
  await fs.writeFile(path.join(bin, "vim"), createEditorScript(vimMarker), { mode: 0o755 });
  writeTranscriptConfig(agentDir, { editor: "auto" });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = bin;
  try {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    extension({
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        command = options;
      },
    } as never);
    assert.ok(command);

    const lifecycle: string[] = [];
    const notifications: Array<{ message: string; type?: string }> = [];
    let inAppCalls = 0;
    let inAppContent: string | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        custom: <T>(
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void,
          ) => unknown,
        ) =>
          new Promise<T>((resolve) => {
            factory(
              {
                stop: () => lifecycle.push("stop"),
                start: () => lifecycle.push("start"),
                requestRender: () => lifecycle.push("render"),
              },
              {},
              {},
              resolve,
            );
          }),
        editor: async (_title: string, content: string) => {
          inAppCalls++;
          inAppContent = content;
        },
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        select: async () => undefined,
      },
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            timestamp: "2026-08-31T00:00:00.000Z",
            message: { role: "user", content: "hello" },
          },
        ],
        buildContextEntries: () => [],
        getSessionFile: () => sessionFile,
      },
      modelRegistry: {},
      getSystemPromptOptions: () => ({}),
    };
    await command.handler("latest-user", ctx);

    const marker = await fs.readFile(nvimMarker, "utf8");
    assert.match(marker, /^called\/.*transcript-/);
    await assert.rejects(() => fs.access(vimMarker));
    assert.deepEqual(lifecycle, ["stop", "start", "render"]);
    assert.equal(notifications.length, 0);

    writeTranscriptConfig(agentDir, { editor: "vim" });
    await command.handler("latest-user", ctx);
    const vimContent = await fs.readFile(vimMarker, "utf8");
    assert.match(vimContent, /^called\/.*transcript-/);
    assert.equal(inAppCalls, 0);
    assert.deepEqual(lifecycle, ["stop", "start", "render", "stop", "start", "render"]);

    await fs.rm(path.join(bin, "vim"));
    await command.handler("latest-user", ctx);
    assert.equal(inAppCalls, 1);
    assert.equal(notifications.length, 1);
    const failureNotification = notifications[0];
    if (!failureNotification) throw new Error("missing external editor failure notification");
    assert.match(
      failureNotification.message,
      /Executable not found in \$PATH: "vim"|spawn vim ENOENT/,
    );
    assert.equal(failureNotification.type, "error");

    writeTranscriptConfig(agentDir, { editor: "builtin" });
    await command.handler("latest-user", ctx);
    assert.equal(inAppCalls, 2);
    assert.ok(inAppContent?.includes(`│ File · ${sessionFile}`));
    assert.deepEqual(lifecycle, [
      "stop",
      "start",
      "render",
      "stop",
      "start",
      "render",
      "stop",
      "start",
      "render",
    ]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
