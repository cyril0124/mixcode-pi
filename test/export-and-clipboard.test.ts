import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseInput } from "../src/core/commands.js";
import { clipboardPasteForEditor } from "../src/core/pi-private.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import type { OverlayTui } from "../src/ui/app-types.js";

function mockTui(): OverlayTui {
  return {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
  } as unknown as OverlayTui;
}

test("parseInput recognizes /export with optional path", () => {
  assert.deepEqual(parseInput("/export"), {
    kind: "local-command",
    command: "export",
    args: "",
  });
  assert.deepEqual(parseInput("/export ./out.html"), {
    kind: "local-command",
    command: "export",
    args: "./out.html",
  });
  assert.deepEqual(parseInput("/export ./branch.jsonl"), {
    kind: "local-command",
    command: "export",
    args: "./branch.jsonl",
  });
});

test("handleSubmittedInput /export routes html vs jsonl via Pi APIs", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  const calls: Array<{ kind: "html" | "jsonl"; path?: string }> = [];
  const runtime = {
    getTab: () => ({
      agentSession: {
        exportToHtml: async (outputPath?: string) => {
          calls.push({ kind: "html", path: outputPath });
          return outputPath ?? "/tmp/session.html";
        },
        exportToJsonl: (outputPath?: string) => {
          calls.push({ kind: "jsonl", path: outputPath });
          return outputPath ?? "/tmp/session.jsonl";
        },
      },
    }),
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/export", mockTui());
  await handleSubmittedInput(state, runtime, "/export ./chat.html", mockTui());
  await handleSubmittedInput(state, runtime, "/export ./chat.jsonl", mockTui());

  assert.deepEqual(calls, [
    { kind: "html", path: undefined },
    { kind: "html", path: "./chat.html" },
    { kind: "jsonl", path: "./chat.jsonl" },
  ]);
  assert.equal(tab.toast?.type, "success");
  assert.match(tab.toast?.message ?? "", /Session exported to: \.\/chat\.jsonl/);
});

test("clipboardPasteForEditor prefers image temp path over text", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clipboard-paste-"));
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const image = await clipboardPasteForEditor({
      tempDir: dir,
      readImage: async () => ({ bytes: png, mimeType: "image/png" }),
      imageExt: async () => "png",
      readText: async () => "should-not-use",
    });
    assert.equal(image?.kind, "image");
    if (image?.kind !== "image") return;
    assert.ok(image.path.startsWith(dir));
    assert.ok(image.path.endsWith(".png"));
    assert.deepEqual(new Uint8Array(await fsPromises.readFile(image.path)), png);

    const text = await clipboardPasteForEditor({
      tempDir: dir,
      readImage: async () => null,
      readText: async () => "hello clipboard",
    });
    assert.deepEqual(text, { kind: "text", text: "hello clipboard" });

    const empty = await clipboardPasteForEditor({
      tempDir: dir,
      readImage: async () => null,
      readText: async () => null,
    });
    assert.equal(empty, null);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
