import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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

/** Records the editor's CLI arguments, one per line. */
function createArgRecordingEditorScript(marker: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s\\n' "$@" > "${marker}"
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

// The raw targets hand the persisted session file itself to the editor rather
// than a rendered buffer, and report unpersisted or missing files.
test("transcript raw opens the session JSONL file itself and falls back to in-app reading", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-transcript-raw-e2e-"));
  const bin = path.join(root, "bin");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "session-raw.jsonl");
  const rawText = '{"type":"message","role":"user"}\n{"type":"message","role":"assistant"}\n';
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, rawText);
  const nvimMarker = path.join(root, "nvim.marker");
  await fs.writeFile(path.join(bin, "nvim"), createArgRecordingEditorScript(nvimMarker), {
    mode: 0o755,
  });
  writeTranscriptConfig(agentDir, { editor: "auto" });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = bin;
  try {
    type CommandOptions = {
      handler: (args: string, ctx: unknown) => Promise<void>;
      getArgumentCompletions: (prefix: string) => Array<{ value: string }>;
    };
    let command: CommandOptions | undefined;
    extension({
      registerCommand: (_name: string, options: CommandOptions) => {
        command = options;
      },
    } as never);
    assert.ok(command);
    assert.ok(command.getArgumentCompletions("json").some((item) => item.value === "jsonl"));

    let sessionFileResult: string | null = sessionFile;
    const notifications: Array<{ message: string; type?: string }> = [];
    const inAppContent: string[] = [];
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
            factory({ stop: () => {}, start: () => {}, requestRender: () => {} }, {}, {}, resolve);
          }),
        editor: async (_title: string, content: string) => {
          inAppContent.push(content);
        },
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        select: async () => undefined,
      },
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => sessionFileResult,
      },
      modelRegistry: {},
    };

    // The editor receives the session file path verbatim: read-only for `raw`,
    // writable for `raw-edit`.
    await command.handler("raw", ctx);
    const readonlyArgs = (await fs.readFile(nvimMarker, "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(readonlyArgs, [
      "-R",
      "-n",
      "-c",
      "set filetype=json",
      "+normal G",
      sessionFile,
    ]);
    await command.handler("raw-edit", ctx);
    const writableArgs = (await fs.readFile(nvimMarker, "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(writableArgs, ["-n", "-c", "set filetype=json", "+normal G", sessionFile]);
    assert.equal(notifications.length, 0);
    assert.equal(inAppContent.length, 0);

    // Both raw targets are offered as completions.
    assert.deepEqual(
      command.getArgumentCompletions("raw").map((item) => item.value),
      ["raw", "raw-edit"],
    );

    // Unsupported modifiers are rejected before any file is touched.
    await command.handler("raw 3", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /^Error: Turn count and full/);
    await command.handler("raw-edit full", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /^Error: Turn count and full/);

    // An unpersisted session and a missing file both surface an error.
    sessionFileResult = null;
    await command.handler("raw", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /^Error: Session is not persisted/);
    sessionFileResult = path.join(sessionDir, "missing.jsonl");
    await command.handler("raw", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /^Error: Session file is not readable/);

    // The built-in viewer reads the raw file bytes without rendering them.
    sessionFileResult = sessionFile;
    writeTranscriptConfig(agentDir, { editor: "builtin" });
    await command.handler("raw", ctx);
    assert.deepEqual(inAppContent, [rawText]);

    // `jsonl` is accepted as an alias for the read-only raw target.
    await command.handler("jsonl", ctx);
    await command.handler("raw-edit", ctx);
    assert.deepEqual(inAppContent, [rawText, rawText, rawText]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("transcript command exports nested calls in chatlog but not in model context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-transcript-codemode-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeTranscriptConfig(root, { editor: "builtin" });
  try {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    extension({
      registerCommand: (_name: string, options: typeof command) => {
        command = options;
      },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as never);
    assert.ok(command);

    const session = SessionManager.inMemory(root);
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "openai-completions",
      provider: "test",
      model: "test",
      content: [],
      stopReason: "toolUse",
      timestamp: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    session.appendMessage({ role: "user", content: "first round", timestamp: 1 });
    session.appendMessage({
      ...assistant,
      content: [
        {
          type: "toolCall",
          id: "direct",
          name: "read",
          arguments: { path: "/skills/review/SKILL.md" },
        },
        {
          type: "toolCall",
          id: "code-1",
          name: "codemode",
          arguments: { code: "return tools.read({path: '/skills/decoy/SKILL.md'});" },
        },
      ],
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "direct",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "---\nname: review\n---\n\nReview guidelines" }],
      timestamp: 2,
    });
    const nestedError = Array.from({ length: 25 }, (_, i) => `failure-${i + 1}`).join("\n");
    session.appendMessage({
      role: "toolResult",
      toolCallId: "code-1",
      toolName: "codemode",
      isError: false,
      content: [{ type: "text", text: "Script completed\nfiltered first-round output" }],
      timestamp: 3,
      nestedCalls: {
        complete: false,
        calls: [
          {
            id: "code-1/1",
            name: "read",
            arguments: { path: "/skills/review/SKILL.md" },
            status: "ok",
            durationMs: 12,
          },
          { id: "code-1/2", name: "write", argumentsBytes: 9001, status: "ok" },
          {
            id: "code-1/3",
            name: "bash",
            arguments: { command: "failing command" },
            status: "error",
            error: nestedError,
            durationMs: 1234,
          },
          {
            id: "code-1/4",
            name: "edit",
            arguments: { path: "unfinished.ts" },
            status: "unfinished",
          },
        ],
      },
    });
    session.appendMessage({ role: "user", content: "second round", timestamp: 4 });
    session.appendMessage({
      ...assistant,
      content: [
        {
          type: "toolCall",
          id: "code-2",
          name: "codemode",
          arguments: {
            code: 'await tools.edit({path: "saved.ts"}); throw Error("later failure");',
          },
        },
      ],
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "code-2",
      toolName: "codemode",
      isError: true,
      content: [{ type: "text", text: "Script failed\nlater failure" }],
      timestamp: 5,
      nestedCalls: {
        complete: true,
        calls: [
          { id: "code-2/1", name: "edit", arguments: { path: "saved.ts" }, status: "ok" },
          {
            id: "code-2/2",
            name: "read",
            arguments: { path: "/skills/missing/SKILL.md" },
            status: "error",
            error: "ENOENT",
          },
        ],
      },
    });

    const views: string[] = [];
    const ctx = {
      sessionManager: session,
      modelRegistry: { find: () => undefined, getAll: () => [] },
      getSystemPrompt: () => "",
      ui: {
        editor: async (_title: string, content: string) => {
          views.push(content);
        },
        notify: (message: string) => {
          assert.fail(message);
        },
      },
    };
    await command.handler("chatlog full", ctx);
    const full = views.at(-1)!;
    assert.match(full, /Tools · 9 recorded \(incomplete\)/);
    assert.match(full, /Result · 5 success · 3 errors · 1 pending/);
    assert.match(full, /`read` × 3/);
    assert.match(full, /`codemode` × 2/);
    assert.match(full, /`edit` × 2/);
    assert.match(full, /`review` × 2/);
    assert.match(full, /`missing` × 1/);
    assert.doesNotMatch(full, /`decoy` ×/);
    assert.match(full, /Tool: codemode — ✅ success[\s\S]*filtered first-round output/);
    assert.match(full, /Tool: read — ✅ success · via codemode · 0\.0s/);
    assert.match(full, /Tool: bash — ❌ error · via codemode · 1\.2s/);
    assert.match(full, /Tool: edit — ⏳ unfinished · via codemode/);
    assert.match(full, /Arguments omitted: 9001 bytes/);
    assert.match(full, /Nested call record incomplete/);
    assert.match(full, /Nested tool outputs are not recorded/);
    assert.match(full, /failure-1\n/);
    assert.match(full, /failure-25/);
    assert.match(full, /Tool: codemode — ❌ error[\s\S]*Tool: edit — ✅ success · via codemode/);
    assert.equal(full.match(/### 📘 Skill: review/g)?.length, 1);

    await command.handler("chatlog", ctx);
    const capped = views.at(-1)!;
    assert.doesNotMatch(capped, /failure-1\n/);
    assert.match(capped, /failure-6\n/);
    assert.match(capped, /\+5 earlier lines/);

    await command.handler("chatlog 1 full", ctx);
    const tail = views.at(-1)!;
    assert.match(tail, /Tools · 9 recorded \(incomplete\)/);
    assert.match(tail, /earlier 1 turn omitted/);
    assert.match(tail, /saved\.ts/);
    assert.doesNotMatch(tail, /unfinished\.ts|filtered first-round output/);

    await command.handler("context full", ctx);
    const context = views.at(-1)!;
    assert.match(context, /Script completed/);
    assert.doesNotMatch(context, /via codemode|failure-25|Arguments omitted|Nested tool outputs/);
    assert.equal(session.getBranch().filter((entry) => entry.type === "message").length, 7);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});
