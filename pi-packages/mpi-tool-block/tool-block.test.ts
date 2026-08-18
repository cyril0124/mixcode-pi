import * as assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildToolBlockRows,
  deniedToolNames,
  effectiveToolBlockConfig,
  filterToolBlockRows,
  isToolBlockEnabled,
  loadToolBlockConfig,
  parseToolBlockConfig,
  planActiveTools,
  pluginTag,
  sameToolNames,
  toggleToolBlockRow,
  toolBlockConfigPath,
  writeToolBlockConfig,
  type ToolBlockConfig,
  type ToolRef,
} from "./tool-block-core.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tool-block-"));
  tmpDirs.push(d);
  return d;
}

describe("parseToolBlockConfig", () => {
  test("accepts enabled + hidden tool/plugin pairs", () => {
    const parsed = parseToolBlockConfig({
      enabled: true,
      hidden: [{ tool: "browser_navigate", plugin: "pi-web-access" }],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.config, {
      enabled: true,
      hidden: [{ tool: "browser_navigate", plugin: "pi-web-access" }],
    });
  });

  test("defaults omitted enabled/hidden", () => {
    const parsed = parseToolBlockConfig({});
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.config, { enabled: true, hidden: [] });
  });

  test("accepts hidden entries with only a tool name", () => {
    const parsed = parseToolBlockConfig({ hidden: [{ tool: "bash" }] });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.config.hidden, [{ tool: "bash" }]);
  });

  test("rejects invalid JSON shapes fail-loud", () => {
    assert.equal(parseToolBlockConfig([]).ok, false);
    assert.equal(parseToolBlockConfig("x").ok, false);
    assert.equal(parseToolBlockConfig({ enabled: "yes" }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: "bash" }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: [{ tool: "", plugin: "x" }] }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: [{ tool: "bash", plugin: "" }] }).ok, false);
    assert.equal(parseToolBlockConfig({ extra: true }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: [{ tool: "bash", plugin: "b", extra: 1 }] }).ok, false);
    assert.equal(
      parseToolBlockConfig({
        hidden: [
          { tool: "bash", plugin: "a" },
          { tool: "bash", plugin: "b" },
        ],
      }).ok,
      false,
    );
  });
});

describe("deniedToolNames / planActiveTools", () => {
  const config: ToolBlockConfig = {
    enabled: true,
    hidden: [
      { tool: "browser_navigate", plugin: "pi-web-access" },
      { tool: "create_goal", plugin: "mpi-goal" },
    ],
  };

  test("enabled config denies only listed names", () => {
    assert.deepEqual(deniedToolNames(config), ["browser_navigate", "create_goal"]);
  });

  test("session config replaces global while present", () => {
    const globalCfg: ToolBlockConfig = {
      enabled: true,
      hidden: [{ tool: "bash" }],
    };
    const sessionCfg: ToolBlockConfig = {
      enabled: true,
      hidden: [{ tool: "read", plugin: "" }],
    };
    assert.deepEqual(effectiveToolBlockConfig(globalCfg, null), globalCfg);
    assert.deepEqual(effectiveToolBlockConfig(globalCfg, sessionCfg), sessionCfg);
    assert.equal(effectiveToolBlockConfig(null, null), null);
    assert.deepEqual(deniedToolNames(effectiveToolBlockConfig(globalCfg, sessionCfg)), ["read"]);
    assert.deepEqual(
      deniedToolNames(effectiveToolBlockConfig(globalCfg, { enabled: false, hidden: [{ tool: "read" }] })),
      [],
    );
  });

  test("disabled or missing config denies nothing", () => {
    assert.deepEqual(deniedToolNames({ ...config, enabled: false }), []);
    assert.deepEqual(deniedToolNames(null), []);
  });

  test("removes denied names and does not activate unrelated registered tools", () => {
    const planned = planActiveTools({
      active: ["read", "bash", "browser_navigate", "create_goal"],
      registered: ["read", "bash", "browser_navigate", "create_goal", "queue_add"],
      denied: ["browser_navigate", "create_goal"],
      previouslyRemoved: [],
    });
    assert.deepEqual(planned.next, ["read", "bash"]);
    assert.deepEqual(planned.removed, ["browser_navigate", "create_goal"]);
  });

  test("restores only names this package previously removed", () => {
    const planned = planActiveTools({
      active: ["read", "bash"],
      registered: ["read", "bash", "browser_navigate", "queue_add"],
      denied: [],
      previouslyRemoved: ["browser_navigate"],
    });
    assert.deepEqual(planned.next, ["read", "bash", "browser_navigate"]);
    assert.deepEqual(planned.removed, []);
  });

  test("denying an inactive registered tool does not later activate it", () => {
    const hidden = planActiveTools({
      active: ["read", "bash"],
      registered: ["read", "bash", "create_goal"],
      denied: ["create_goal"],
      previouslyRemoved: [],
    });
    assert.deepEqual(hidden.next, ["read", "bash"]);
    assert.deepEqual(hidden.removed, []);

    const unhidden = planActiveTools({
      active: hidden.next,
      registered: ["read", "bash", "create_goal"],
      denied: [],
      previouslyRemoved: hidden.removed,
    });
    assert.deepEqual(unhidden.next, ["read", "bash"]);
    assert.deepEqual(unhidden.removed, []);
  });

  test("sameToolNames detects unchanged active set", () => {
    assert.equal(sameToolNames(["read", "bash"], ["read", "bash"]), true);
    assert.equal(sameToolNames(["read", "bash"], ["bash", "read"]), false);
  });
});

describe("pluginTag / items / toggle", () => {
  const tools: ToolRef[] = [
    { name: "bash", plugin: "" },
    { name: "create_goal", plugin: "mpi-goal" },
    { name: "browser_navigate", plugin: "pi-web-access" },
  ];

  test("pluginTag uses extension/npm source and leaves core tools untagged", () => {
    assert.equal(pluginTag({ source: "builtin", path: "<builtin:bash>" }), "");
    assert.equal(pluginTag({ source: "npm:pi-web-access", path: "/x/node_modules/pi-web-access/index.ts" }), "pi-web-access");
    assert.equal(
      pluginTag({ source: "package", path: "/home/u/.pi/agent/extensions/mpi-goal/index.ts" }),
      "mpi-goal",
    );
  });

  test("buildToolBlockRows groups by plugin and marks hidden tools", () => {
    const rows = buildToolBlockRows(tools, {
      enabled: true,
      hidden: [{ tool: "create_goal", plugin: "mpi-goal" }],
    });
    assert.equal(rows[0]?.kind, "layer");
    assert.equal(rows[1]?.kind, "enabled");
    assert.ok(rows.some((row) => row.kind === "header" && row.plugin === "mpi-goal"));
    const goal = rows.find((row) => row.kind === "tool" && row.name === "create_goal");
    assert.ok(goal && goal.kind === "tool");
    assert.equal(goal.hidden, true);
    const bash = rows.find((row) => row.kind === "tool" && row.name === "bash");
    assert.ok(bash && bash.kind === "tool");
    assert.equal(bash.hidden, false);
  });

  test("keeps orphan hidden tools in the list", () => {
    const rows = buildToolBlockRows(tools, {
      enabled: true,
      hidden: [{ tool: "gone_tool", plugin: "old-plugin" }],
    });
    const orphan = rows.find((row) => row.kind === "tool" && row.name === "gone_tool");
    assert.ok(orphan && orphan.kind === "tool");
    assert.equal(orphan.hidden, true);
    assert.equal(orphan.orphan, true);
    assert.ok(rows.some((row) => row.kind === "header" && row.plugin === "old-plugin"));
  });

  test("filterToolBlockRows keeps plugin headers for matches", () => {
    const rows = buildToolBlockRows(tools, { enabled: true, hidden: [] });
    const filtered = filterToolBlockRows(rows, "goal");
    assert.equal(filtered[0]?.kind, "layer");
    assert.ok(filtered.some((row) => row.kind === "header" && row.plugin === "mpi-goal"));
    assert.ok(filtered.some((row) => row.kind === "tool" && row.name === "create_goal"));
    assert.equal(
      filtered.some((row) => row.kind === "tool" && row.name === "bash"),
      false,
    );
  });

  test("toggle hides, unhides, and flips enabled without dropping other rows", () => {
    let next = toggleToolBlockRow({ enabled: true, hidden: [] }, tools, {
      kind: "tool",
      name: "create_goal",
      plugin: "mpi-goal",
      hidden: false,
    });
    assert.deepEqual(next.hidden, [{ tool: "create_goal", plugin: "mpi-goal" }]);
    next = toggleToolBlockRow(next, tools, { kind: "enabled" });
    assert.equal(isToolBlockEnabled(next), false);
    assert.equal(next.hidden.length, 1);
    next = toggleToolBlockRow(next, tools, {
      kind: "tool",
      name: "create_goal",
      plugin: "mpi-goal",
      hidden: true,
    });
    assert.deepEqual(next.hidden, []);
    assert.equal(next.enabled, false);
  });
});

describe("load / write tool-block.json", () => {
  test("missing file is a no-op config", () => {
    const dir = tmpDir();
    const loaded = loadToolBlockConfig(dir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.missing, true);
    assert.equal(loaded.config, null);
    assert.equal(loaded.path, toolBlockConfigPath(dir));
  });

  test("round-trips a written config and fail-louds invalid files", () => {
    const dir = tmpDir();
    const written = writeToolBlockConfig(dir, {
      enabled: true,
      hidden: [{ tool: "bash" }],
    });
    assert.equal(written.ok, true);
    if (!written.ok) return;
    const loaded = loadToolBlockConfig(dir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.config, {
      enabled: true,
      hidden: [{ tool: "bash" }],
    });

    fs.writeFileSync(toolBlockConfigPath(dir), "{", "utf8");
    const bad = loadToolBlockConfig(dir);
    assert.equal(bad.ok, false);
  });
});

describe("tool-block overlay", () => {
  const tools: ToolRef[] = [
    { name: "bash", plugin: "" },
    { name: "create_goal", plugin: "mpi-goal" },
  ];

  test("renders settings-style rows, title, and config path", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    let draft: ToolBlockConfig = {
      enabled: true,
      hidden: [{ tool: "create_goal", plugin: "mpi-goal" }],
    };
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: draft,
      configPath: "/tmp/agent/tool-block.json",
      persist: (config) => {
        draft = config;
        return { ok: true, config };
      },
    });
    const text = view.render(60).join("\n");
    const lines = text.split("\n");
    assert.match(lines[0] ?? "", /^┌.*Tool Block.*┐$/);
    assert.match(lines.at(-1) ?? "", /^└─+┘$/);
    assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
    assert.doesNotMatch(text, /builtin/i);
    assert.match(text, /mpi-goal/);
    assert.match(text, /Layer/);
    assert.match(text, /Global/);
    assert.match(text, /Enabled/);
    assert.match(text, /On/);
    assert.match(text, /create_goal/);
    assert.match(text, /Hidden/);
    assert.match(text, /bash/);
    assert.match(text, /Visible/);
    assert.match(text, /\/tmp\/agent\/tool-block.json/);
  });

  test("space toggles a tool and persist writes the next config", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const writes: Array<{ config: ToolBlockConfig; layer: string }> = [];
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: { enabled: true, hidden: [] },
      configPath: "/tmp/agent/tool-block.json",
      persist: (config, layer) => {
        writes.push({ config, layer });
        return { ok: true, config };
      },
    });
    view.handleInput("\x1b[B"); // skip layer -> enabled
    view.handleInput("\x1b[B"); // skip enabled -> bash
    view.handleInput(" ");
    assert.equal(writes.at(-1)?.layer, "global");
    assert.deepEqual(writes.at(-1)?.config.hidden, [{ tool: "bash" }]);
    assert.match(view.render(60).join("\n"), /bash[\s\S]*Hidden/);
  });

  test("layer switch snapshots global into session and later tool toggles stay in-memory", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const writes: Array<{ config: ToolBlockConfig; layer: string }> = [];
    const global: ToolBlockConfig = {
      enabled: true,
      hidden: [{ tool: "create_goal", plugin: "mpi-goal" }],
    };
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: global,
      configPath: "/tmp/agent/tool-block.json",
      persist: (config, layer) => {
        writes.push({ config, layer });
        return { ok: true, config };
      },
    });
    view.handleInput(" "); // Layer -> Session, snapshot global
    assert.equal(writes.at(-1)?.layer, "session");
    assert.deepEqual(writes.at(-1)?.config.hidden, [{ tool: "create_goal", plugin: "mpi-goal" }]);
    assert.match(view.render(60).join("\n"), /session \(in-memory\)/);
    assert.match(view.render(60).join("\n"), /Layer[\s\S]*Session/);

    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash
    view.handleInput(" ");
    assert.equal(writes.at(-1)?.layer, "session");
    assert.deepEqual(writes.at(-1)?.config.hidden, [
      { tool: "bash" },
      { tool: "create_goal", plugin: "mpi-goal" },
    ]);

    view.handleInput("\x1b[A");
    view.handleInput("\x1b[A");
    view.handleInput(" "); // Layer -> Global, session stays
    assert.match(view.render(60).join("\n"), /session override · \/tmp\/agent\/tool-block.json/);
    const beforeGlobalEdit = writes.length;
    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash on global draft (still empty hidden)
    view.handleInput(" ");
    assert.equal(writes.length, beforeGlobalEdit + 1);
    assert.equal(writes.at(-1)?.layer, "global");
    assert.deepEqual(writes.at(-1)?.config.hidden, [
      { tool: "bash" },
      { tool: "create_goal", plugin: "mpi-goal" },
    ]);
  });

  test("windows the list when the overlay body budget is short", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${String(i).padStart(2, "0")}`, plugin: "" }));
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools: many,
      initial: { enabled: true, hidden: [] },
      configPath: "/tmp/agent/tool-block.json",
      persist: (config) => ({ ok: true, config }),
      getMaxVisible: () => 8,
    });
    for (let i = 0; i < 21; i++) view.handleInput("\x1b[B");
    const lines = view.render(60).join("\n").split("\n");
    assert.ok(lines.length <= 10, `height ${lines.length} should stay near the 8-line body budget`);
    assert.match(lines[0] ?? "", /┌.*Tool Block/);
    assert.match(lines.at(-1) ?? "", /└─+┘/);
    assert.match(lines.join("\n"), /tool_19/);
  });
});
