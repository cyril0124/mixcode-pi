import assert from "node:assert/strict";
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
