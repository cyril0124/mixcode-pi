import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { formatExtensionSummaries } from "../src/agent/runtime-startup-header.js";
import {
  extensionManagerEntriesFromResult,
  syncExtensionManagerEntrySources,
} from "../src/core/extension-manager.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeState } from "../src/core/types.js";
import type { ExtensionManagerEntry } from "../src/core/extension-manager.js";
import {
  ExtensionManagerPanel,
  openExtensionManager,
} from "../src/ui/components/extension-manager.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const NOOP_TUI = {
  requestRender: () => undefined,
  showOverlay: () => ({ hide: () => undefined }) as never,
};

/** Standalone panel for render/key contract tests (no overlay host needed). */
function testPanel(
  state: MixCodeState,
  entries: ExtensionManagerEntry[],
  init?: Partial<Pick<ExtensionManagerPanel, "selectedIndex" | "searchActive" | "searchQuery">>,
): ExtensionManagerPanel {
  // Render/key contract tests never trigger reloads; only the entry provider
  // is needed to satisfy the required runtime dependency.
  const runtime = { getExtensionManagerEntries: () => entries } as never;
  const panel = new ExtensionManagerPanel({ state, tui: NOOP_TUI, runtime }, entries);
  Object.assign(panel, init);
  return panel;
}

// Build a minimal Extension-like object with just the fields the entry mapper
// reads. The tools/commands Maps only need keys; values are irrelevant here.
function fakeExtension(path: string, source: string, toolNames: string[], commandNames: string[]) {
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

test("extension manager names local extensions from their entry path", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const entries: ExtensionManagerEntry[] = [
    {
      key: "user:auto:top-level:/home/user/.pi/agent/extensions/mpi-loop/index.ts",
      enabled: true,
      path: "/home/user/.pi/agent/extensions/mpi-loop/index.ts",
      resolvedPath: "/home/user/.pi/agent/extensions/mpi-loop/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      baseDir: "/home/user/.pi/agent",
      toolCount: 0,
      commandCount: 1,
      toolNames: [],
      commandNames: ["loop"],
    },
    {
      key: "user:npm:@scope/pkg:package:/home/user/node_modules/@scope/pkg/extensions/feature/index.ts",
      enabled: true,
      path: "/home/user/node_modules/@scope/pkg/extensions/feature/index.ts",
      resolvedPath: "/home/user/node_modules/@scope/pkg/extensions/feature/index.ts",
      source: "npm:@scope/pkg",
      scope: "user",
      origin: "package",
      baseDir: "/home/user/node_modules/@scope/pkg",
      toolCount: 0,
      commandCount: 0,
      toolNames: [],
      commandNames: [],
    },
  ];

  const rendered = stripAnsi(
    testPanel(state, entries, { selectedIndex: 1 }).render(100).join("\n"),
  );
  assert.match(rendered, /● mpi-loop/);
  assert.match(rendered, /● pkg/);
});

test("extension manager keeps its footer inside the default overlay height", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const entries: ExtensionManagerEntry[] = Array.from({ length: 30 }, (_, index) => ({
    key: `extension-${index}`,
    enabled: true,
    path: `/extensions/extension-${index}/index.ts`,
    resolvedPath: `/extensions/extension-${index}/index.ts`,
    source: "auto",
    scope: "user",
    origin: "top-level",
    toolCount: 0,
    commandCount: 0,
    toolNames: [],
    commandNames: [],
  }));

  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
  try {
    const rendered = testPanel(state, entries, { selectedIndex: 29 }).render(60).map(stripAnsi);
    assert.ok(rendered.length <= Math.floor(12 * 0.8));
    assert.match(rendered.join("\n"), /\(30\/30\)/);
    assert.match(rendered.at(-1) ?? "", /^└─+┘$/);
  } finally {
    if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
    else Reflect.deleteProperty(process.stdout, "rows");
  }
});

test("closing the extension manager prevents a pending reload from restoring its overlay", async () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const reload = Promise.withResolvers<{
    sessionId: string;
    title: string;
    status: "reloaded";
  }>();
  let overlayOpen = false;
  let showCount = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      showCount++;
      return { hide: () => (overlayOpen = false) } as never;
    },
  };
  const runtime = {
    getExtensionManagerEntries: () => [],
    reloadExtensionManagerTab: () => reload.promise,
  } as unknown as MixCodeRuntime;

  const panel = openExtensionManager(state, runtime, tui);
  panel.handleInput("r");
  panel.handleInput("\x1b");
  assert.equal(overlayOpen, false);

  reload.resolve({ sessionId: "s1", title: "Agent-01", status: "reloaded" });
  await Bun.sleep(0);
  assert.equal(state.extensionManager.open, false);
  assert.equal(overlayOpen, false);
  assert.equal(showCount, 1);
  assert.equal(panel.message, "");
});

test("a pending reload cannot update a newly opened extension manager", async () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const reload = Promise.withResolvers<{
    sessionId: string;
    title: string;
    status: "reloaded";
  }>();
  let showCount = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      showCount++;
      return { hide: () => undefined } as never;
    },
  };
  const runtime = {
    getExtensionManagerEntries: () => [],
    reloadExtensionManagerTab: () => reload.promise,
  } as unknown as MixCodeRuntime;

  const first = openExtensionManager(state, runtime, tui);
  first.handleInput("r");
  first.handleInput("\x1b");
  const reopened = openExtensionManager(state, runtime, tui);

  reload.resolve({ sessionId: "s1", title: "Agent-01", status: "reloaded" });
  await Bun.sleep(0);
  assert.equal(reopened.message, "");
  assert.equal(reopened.working, false);
  assert.equal(first.message, "", "stale reload must not surface a result");
  assert.equal(showCount, 2);
});

test("extension manager detail paging reaches commands and paths after a long tool list", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const entries: ExtensionManagerEntry[] = [
    {
      key: "rich-extension",
      enabled: true,
      path: "/extensions/rich-extension/index.ts",
      resolvedPath: "/extensions/rich-extension/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 24,
      commandCount: 2,
      toolNames: Array.from({ length: 24 }, (_, index) => `tool_${index}`),
      commandNames: ["alpha", "omega"],
    },
  ];
  const panel = testPanel(state, entries);
  const render = () => stripAnsi(panel.render(100).join("\n"));

  assert.doesNotMatch(render(), /\/omega/);
  assert.match(render(), /details .*▼/);
  panel.handleInput("\x1b[6~");
  panel.handleInput("\x1b[6~");
  assert.match(render(), /\/omega/);
  assert.match(render(), /\/extensions\/rich-extension\/index\.ts/);
  assert.match(render(), /▲ details/);
});

test("extension manager preserves wide characters while wrapping paths", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const path = `/extensions/${"中文".repeat(30)}/终点😀.ts`;
  const entries: ExtensionManagerEntry[] = [
    {
      key: "wide-path",
      enabled: true,
      path,
      resolvedPath: path,
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 0,
      commandCount: 0,
      toolNames: [],
      commandNames: [],
    },
  ];

  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
  try {
    const rendered = stripAnsi(testPanel(state, entries).render(100).join("\n"));
    assert.match(rendered, /终点😀\.ts/);
    assert.doesNotMatch(rendered, /�/);
  } finally {
    if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
    else Reflect.deleteProperty(process.stdout, "rows");
  }
});

test("extension manager switches to two panes at 80 terminal columns", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const entries: ExtensionManagerEntry[] = [
    {
      key: "extension",
      enabled: true,
      path: "/extensions/extension/index.ts",
      resolvedPath: "/extensions/extension/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 0,
      commandCount: 0,
      toolNames: [],
      commandNames: [],
    },
  ];

  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 79 });
    const singlePane = stripAnsi(
      testPanel(state, entries)
        .render(Math.floor(79 * 0.78))
        .join("\n"),
    );
    assert.doesNotMatch(singlePane, /status\s+enabled/);

    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
    const doublePane = stripAnsi(
      testPanel(state, entries)
        .render(Math.floor(80 * 0.78))
        .join("\n"),
    );
    assert.match(doublePane, /status\s+enabled/);
  } finally {
    if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
    else Reflect.deleteProperty(process.stdout, "columns");
  }
});

test("extension manager search matches command names", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const entries: ExtensionManagerEntry[] = [
    {
      key: "rename",
      enabled: true,
      path: "/extensions/rename/index.ts",
      resolvedPath: "/extensions/rename/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 0,
      commandCount: 1,
      toolNames: [],
      commandNames: ["auto-rename"],
    },
    {
      key: "context",
      enabled: true,
      path: "/extensions/context/index.ts",
      resolvedPath: "/extensions/context/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 0,
      commandCount: 1,
      toolNames: [],
      commandNames: ["inspect-context"],
    },
  ];
  const panel = testPanel(state, entries, { searchActive: true, searchQuery: "inspect-context" });

  const rendered = stripAnsi(panel.render(79).join("\n"));
  assert.match(rendered, /● context/);
  assert.doesNotMatch(rendered, /● rename/);
  assert.match(rendered, /1\/2 extensions/);
});

test("extension manager search keyboard flow toggles the filtered entry", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, icons: { mode: "nerd" } };
  const entries: ExtensionManagerEntry[] = [
    {
      key: "rename",
      enabled: true,
      path: "/extensions/rename/index.ts",
      resolvedPath: "/extensions/rename/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 0,
      commandCount: 0,
      toolNames: [],
      commandNames: [],
    },
    {
      key: "skill",
      enabled: true,
      path: "/extensions/skill/index.ts",
      resolvedPath: "/extensions/skill/index.ts",
      source: "auto",
      scope: "user",
      origin: "top-level",
      toolCount: 0,
      commandCount: 0,
      toolNames: [],
      commandNames: [],
    },
  ];
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return { hide: () => (overlayOpen = false) } as never;
    },
  };
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const runtime = { getExtensionManagerEntries: () => entries } as unknown as MixCodeRuntime;
  const panel = openExtensionManager(state, runtime, tui);
  const render = () => stripAnsi(panel.render(79).join("\n"));

  panel.handleInput("\x1b[47u");
  panel.handleInput("\x1b[115u");
  for (const char of "kill") panel.handleInput(char);
  assert.match(render(), /● skill/);
  assert.doesNotMatch(render(), /● rename/);

  panel.handleInput("x");
  assert.match(render(), /No extensions match "skillx"/);
  panel.handleInput("\x7f");
  assert.match(render(), /● skill/);

  panel.handleInput("\r");
  panel.handleInput(" ");
  assert.equal(entries[0]!.enabled, true);
  assert.equal(entries[1]!.enabled, false);

  panel.handleInput("\x1b");
  assert.match(render(), /● rename/);
  assert.equal(overlayOpen, true);
  panel.handleInput("\x1b");
  assert.equal(overlayOpen, false);
});
