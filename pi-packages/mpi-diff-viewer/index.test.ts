import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import extension from "./index.js";
import type { ReviewDraft } from "./review.js";

function registerDiff() {
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  extension({
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: never) => Promise<void> },
    ) {
      commands.set(name, command);
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
  assert.match(notices[0] ?? "", /^Error: /);
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
