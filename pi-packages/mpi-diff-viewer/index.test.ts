import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import extension from "./index.js";
import type { ReviewDraft } from "./review.js";
import {
  buildSessionDiff,
  DIRECT_MOD_ENTRY_TYPE,
  FILE_MOD_ENTRY_TYPE,
  type SessionEntry,
} from "./session-diff.js";

interface ToolResultEventFixture {
  toolCallId: string;
  toolName: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
  details?: { patch?: string };
  isError: boolean;
}

function registerDiff(
  hooks: {
    onToolResult?: (handler: (event: ToolResultEventFixture) => void | Promise<void>) => void;
    appendEntry?: (type: string, data: unknown) => void;
  } = {},
) {
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  extension({
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: never) => Promise<void> },
    ) {
      commands.set(name, command);
    },
    on(event: string, handler: (event: ToolResultEventFixture) => void | Promise<void>) {
      if (event === "tool_result") hooks.onToolResult?.(handler);
      return () => {};
    },
    appendEntry(type: string, data: unknown) {
      hooks.appendEntry?.(type, data);
    },
  } as never);
  return commands;
}

const draft: ReviewDraft = {
  comments: [
    {
      target: {
        kind: "line",
        path: "new.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        code: ["export const value = 1;"],
      },
      intent: "fix",
      body: "Use a descriptive name.",
    },
  ],
};

const branch = [
  { type: "message", message: { role: "user", content: "add file" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "write-1",
          name: "write",
          arguments: { path: "new.ts", content: "export const value = 1;" },
        },
      ],
    },
  },
  {
    type: "message",
    message: { role: "toolResult", toolCallId: "write-1", content: [] },
  },
];

test("codemode edit and write appear in full and last-turn diffs after session serialization", async () => {
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-codemode-"));
  const entries: SessionEntry[] = [
    { type: "message", message: { role: "user", content: "create" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "old", name: "codemode", arguments: { code: "write" } }],
      },
    },
  ];
  let resultHandler: ((event: ToolResultEventFixture) => void | Promise<void>) | undefined;
  let recorded = 0;
  const commands = registerDiff({
    onToolResult: (handler) => {
      resultHandler = handler;
    },
    appendEntry: (customType, data) => {
      recorded += 1;
      entries.push({ type: "custom", customType, data });
    },
  });

  try {
    assert.ok(resultHandler, "the extension must observe nested tool results");
    await resultHandler({
      toolCallId: "old/1",
      toolName: "write",
      parentToolCallId: "old",
      input: { path: "sample.ts", content: "before\n" },
      isError: false,
    });
    entries.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "old", content: [] },
    });
    entries.push({ type: "message", message: { role: "user", content: "current" } });
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "now", name: "codemode", arguments: { code: "write and edit" } },
          {
            type: "toolCall",
            id: "direct",
            name: "write",
            arguments: { path: "direct.ts", content: "direct\n" },
          },
        ],
      },
    });
    await resultHandler({
      toolCallId: "now/1",
      toolName: "write",
      parentToolCallId: "now",
      input: { path: "sample.ts", content: "middle\n" },
      isError: false,
    });
    await resultHandler({
      toolCallId: "now/2",
      toolName: "edit",
      parentToolCallId: "now",
      input: { path: "sample.ts" },
      details: { patch: "--- sample.ts\n+++ sample.ts\n@@ -1 +1 @@\n-middle\n+final\n" },
      isError: false,
    });
    const largeContent = "x".repeat(9_000) + "\n";
    await resultHandler({
      toolCallId: "now/3",
      toolName: "write",
      parentToolCallId: "now",
      input: { path: "large.txt", content: largeContent },
      isError: false,
    });
    await resultHandler({
      toolCallId: "now/4",
      toolName: "write",
      parentToolCallId: "now",
      input: { path: "failed.ts", content: "not written" },
      isError: true,
    });
    await resultHandler({
      toolCallId: "now/5",
      toolName: "read",
      parentToolCallId: "now",
      input: { path: "sample.ts" },
      isError: false,
    });
    await resultHandler({
      toolCallId: "direct",
      toolName: "write",
      input: { path: "direct.ts", content: "direct\n" },
      isError: false,
    });
    assert.equal(recorded, 5, "four nested changes and one direct ordering marker");
    assert.equal(entries.filter((entry) => entry.customType === FILE_MOD_ENTRY_TYPE).length, 4);
    assert.deepEqual(
      entries
        .filter((entry) => entry.customType === DIRECT_MOD_ENTRY_TYPE)
        .map((entry) => entry.data),
      [{ toolCallId: "direct" }],
    );

    fs.writeFileSync(path.join(cwd, "sample.ts"), "final\n");
    fs.writeFileSync(path.join(cwd, "direct.ts"), "direct\n");
    fs.writeFileSync(path.join(cwd, "large.txt"), largeContent);
    entries.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "direct", content: [] },
    });
    entries.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "now", content: [] },
    });

    const restoredEntries = JSON.parse(JSON.stringify(entries)) as SessionEntry[];
    const currentTurn = restoredEntries.findIndex((entry) => entry.message?.content === "current");
    const diff = buildSessionDiff(
      restoredEntries.slice(currentTurn),
      cwd,
      restoredEntries.slice(0, currentTurn),
    );
    assert.equal(diff.trackedFiles, 3);
    assert.deepEqual(diff.files.map(({ path: filePath }) => filePath).sort(), [
      "direct.ts",
      "large.txt",
      "sample.ts",
    ]);
    assert.equal(diff.files.find((file) => file.path === "sample.ts")?.status, "modified");
    assert.equal(
      diff.files.find((file) => file.path === "sample.ts")?.hunks[0]?.rows[0]?.oldText,
      "before",
    );
    assert.equal(
      diff.files.find((file) => file.path === "sample.ts")?.hunks[0]?.rows[0]?.newText,
      "final",
    );
    assert.equal(
      diff.files.find((file) => file.path === "large.txt")?.hunks[0]?.rows[0]?.newText.length,
      9_000,
    );

    let opened = 0;
    const notices: string[] = [];
    const ctx = {
      cwd,
      sessionManager: { getBranch: () => restoredEntries },
      ui: {
        custom: async () => {
          opened += 1;
          return undefined;
        },
        notify: (message: string) => {
          notices.push(message);
        },
      },
    } as never;
    await commands.get("diff")!.handler("last", ctx);
    await commands.get("diff")!.handler("1-2", ctx);
    await commands.get("diff")!.handler("", ctx);
    await commands.get("dl")!.handler("", ctx);
    assert.equal(opened, 4);
    assert.deepEqual(notices, []);
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }
});

test("same-file direct and codemode writes follow their actual completion order", async () => {
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-mixed-order-"));
  const entries: SessionEntry[] = [
    { type: "message", message: { role: "user", content: "change" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "codemode", name: "codemode", arguments: { code: "write" } },
          {
            type: "toolCall",
            id: "direct",
            name: "write",
            arguments: { path: "sample.ts", content: "direct-after\n" },
          },
        ],
      },
    },
  ];
  let resultHandler: ((event: ToolResultEventFixture) => void | Promise<void>) | undefined;
  registerDiff({
    onToolResult: (handler) => {
      resultHandler = handler;
    },
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
  });

  try {
    assert.ok(resultHandler);
    await resultHandler({
      toolCallId: "codemode/1",
      toolName: "write",
      parentToolCallId: "codemode",
      input: { path: "sample.ts", content: "nested-before\n" },
      isError: false,
    });
    await resultHandler({
      toolCallId: "direct",
      toolName: "write",
      input: { path: "sample.ts", content: "direct-after\n" },
      isError: false,
    });
    fs.writeFileSync(path.join(cwd, "sample.ts"), "direct-after\n");
    entries.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "direct", content: [] },
    });
    entries.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "codemode", content: [] },
    });

    const restoredEntries = JSON.parse(JSON.stringify(entries)) as SessionEntry[];
    const diff = buildSessionDiff(restoredEntries, cwd);
    assert.equal(diff.trackedFiles, 1);
    assert.equal(diff.files[0]?.hunks[0]?.rows[0]?.newText, "direct-after");
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }
});

test("/diff inserts submitted review feedback into the Pi editor", async () => {
  const commands = registerDiff();
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-review-"));
  let editorText = "";
  try {
    await commands.get("diff")!.handler("", {
      cwd,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: async () => draft,
        notify: () => {},
        getEditorText: () => editorText,
        setEditorText: (text: string) => {
          editorText = text;
        },
      },
    } as never);
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }

  assert.match(editorText, /FIX/);
  assert.match(editorText, /new\.ts:1 \(added\)/);
  assert.match(editorText, /Use a descriptive name\./);
  assert.match(editorText, /export const value = 1;/);
});

test("/diff appends review feedback after existing editor text", async () => {
  const commands = registerDiff();
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-review-append-"));
  let editorText = "Keep this draft.";
  try {
    await commands.get("diff")!.handler("", {
      cwd,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: async () => draft,
        notify: () => {},
        getEditorText: () => editorText,
        setEditorText: (text: string) => {
          editorText = text;
        },
      },
    } as never);
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }

  assert.match(editorText, /^Keep this draft\.\n\n/);
  assert.match(editorText, /Use a descriptive name\./);
});

function runGit(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test("/diff HEAD, non-HEAD, and reserved-name refs open the viewer", async () => {
  const commands = registerDiff();
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-head-"));
  const notices: string[] = [];
  let opened = 0;
  try {
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "one\n");
    runGit(cwd, ["add", "tracked.ts"]);
    runGit(cwd, ["commit", "-m", "first"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "two\n");
    runGit(cwd, ["add", "tracked.ts"]);
    runGit(cwd, ["commit", "-m", "second"]);
    runGit(cwd, ["branch", "last", "HEAD~1"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "three\n");

    for (const ref of ["HEAD", "HEAD~1", "refs/heads/last"]) {
      await commands.get("diff")!.handler(ref, {
        cwd,
        sessionManager: { getBranch: () => [] },
        ui: {
          custom: async () => {
            opened += 1;
            return undefined;
          },
          notify: (message: string) => {
            notices.push(message);
          },
        },
      } as never);
    }
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }

  assert.equal(opened, 3);
  assert.deepEqual(notices, []);
});

test("/diff <ref> reports a missing git ref as an Error", async () => {
  const commands = registerDiff();
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-badref-"));
  const notices: string[] = [];
  let opened = 0;
  try {
    runGit(cwd, ["init"]);
    await commands.get("diff")!.handler("no-such-ref", {
      cwd,
      sessionManager: { getBranch: () => [] },
      ui: {
        custom: async () => {
          opened += 1;
          return undefined;
        },
        notify: (message: string) => {
          notices.push(message);
        },
      },
    } as never);
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }

  assert.equal(opened, 0);
  assert.match(notices[0] ?? "", /fatal:|bad revision|unknown revision/i);
  assert.doesNotMatch(notices[0] ?? "", /\n/);
});

test("/diff propagates viewer failures after loading a Git diff", async () => {
  const commands = registerDiff();
  const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-diff-viewer-error-"));
  const notices: string[] = [];
  try {
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "one\n");
    runGit(cwd, ["add", "tracked.ts"]);
    runGit(cwd, ["commit", "-m", "init"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "two\n");

    await assert.rejects(
      commands.get("diff")!.handler("HEAD", {
        cwd,
        sessionManager: { getBranch: () => [] },
        ui: {
          custom: async () => {
            throw new Error("viewer failed");
          },
          notify: (message: string) => {
            notices.push(message);
          },
        },
      } as never),
      /viewer failed/,
    );
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }

  assert.deepEqual(notices, []);
});
