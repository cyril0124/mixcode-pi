import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  extensionManagerEntriesFromResult,
  syncExtensionManagerEntrySources,
} from "../src/core/extension-manager.js";
import { formatExtensionSummaries } from "../src/agent/runtime-startup-header.js";

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

// Pi applies real package sourceInfo only AFTER extensionsOverride returns.
// Entries captured inside the override still have synthetic local/temporary
// metadata; sync copies the post-apply fields so the startup header can label
// packages like Pi (`@scope/pkg:src`) while disable keys stay path-stable.
test("syncExtensionManagerEntrySources restores package labels without rewriting disable keys", () => {
  const path = "/home/user/npm/node_modules/@scope/pkg/src/index.ts";
  const preApplyKey = `temporary:local:top-level:${path}`;
  const entries = extensionManagerEntriesFromResult(
    {
      extensions: [
        {
          path,
          resolvedPath: path,
          sourceInfo: {
            path,
            source: "local",
            scope: "temporary",
            origin: "top-level",
            baseDir: "/home/user/npm/node_modules/@scope/pkg/src",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {},
    } as unknown as LoadExtensionsResult,
    new Set(),
  );
  assert.equal(entries[0]!.key, preApplyKey);
  // Path-only compact form strips trailing index.ts, so the unique tail is "src".
  assert.deepEqual(formatExtensionSummaries(entries).compact, ["src"]);

  syncExtensionManagerEntrySources(entries, {
    extensions: [
      {
        path,
        resolvedPath: path,
        sourceInfo: {
          path,
          source: "npm:@scope/pkg",
          scope: "user",
          origin: "package",
          baseDir: "/home/user/npm/node_modules/@scope/pkg",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {},
  } as unknown as LoadExtensionsResult);

  assert.equal(entries[0]!.key, preApplyKey);
  assert.equal(entries[0]!.source, "npm:@scope/pkg");
  assert.equal(entries[0]!.scope, "user");
  assert.equal(entries[0]!.origin, "package");
  assert.equal(entries[0]!.baseDir, "/home/user/npm/node_modules/@scope/pkg");
  assert.deepEqual(formatExtensionSummaries(entries).compact, ["@scope/pkg:src"]);
});
