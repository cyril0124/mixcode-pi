import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { extensionManagerEntriesFromResult } from "../src/core/extension-manager.js";

// Build a minimal Extension-like object with just the fields the entry mapper
// reads. The tools/commands Maps only need keys; values are irrelevant here.
function fakeExtension(
  path: string,
  source: string,
  toolNames: string[],
  commandNames: string[],
) {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { source, scope: "global", origin: "package", path, baseDir: undefined },
    handlers: new Map(),
    tools: new Map(toolNames.map((name) => [name, {}])),
    messageRenderers: new Map(),
    commands: new Map(commandNames.map((name) => [name, {}])),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

test("extensionManagerEntriesFromResult extracts sorted tool and command names", () => {
  const result = {
    extensions: [
      fakeExtension(
        "/ext/web/index.ts",
        "web",
        ["fetch_content", "web_search", "get_search_content"],
        ["fetch", "search"],
      ),
    ],
    errors: [],
    runtime: {},
  } as unknown as LoadExtensionsResult;

  const entries = extensionManagerEntriesFromResult(result, new Set());
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.toolCount, 3);
  assert.equal(entry.commandCount, 2);
  // Names are sorted alphabetically and counts stay consistent.
  assert.deepEqual(entry.toolNames, ["fetch_content", "get_search_content", "web_search"]);
  assert.deepEqual(entry.commandNames, ["fetch", "search"]);
});

test("extensionManagerEntriesFromResult yields empty name arrays for load errors", () => {
  const result = {
    extensions: [],
    errors: [{ path: "/ext/broken/index.ts", error: "boom" }],
    runtime: {},
  } as unknown as LoadExtensionsResult;

  const entries = extensionManagerEntriesFromResult(result, new Set());
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.toolNames, []);
  assert.deepEqual(entries[0]!.commandNames, []);
  assert.equal(entries[0]!.error, "boom");
});
