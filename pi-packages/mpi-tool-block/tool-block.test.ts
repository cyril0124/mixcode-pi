import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  buildToolBlockRows,
  deniedToolNames,
  effectiveToolBlockConfig,
  filterToolBlockRows,
  isToolBlockEnabled,
  loadToolBlockConfig,
  mergeToolBlockConfigs,
  parseToolBlockConfig,
  planActiveTools,
  pluginTag,
  projectToolBlockConfigPath,
  sameToolNames,
  type ToolBlockConfig,
  type ToolRef,
  toggleToolBlockRow,
  toolBlockConfigPath,
  writeToolBlockConfig,
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
  test("$schema: accepted as string, preserved through toggle and file round-trip", () => {
    const parsed = parseToolBlockConfig({
      $schema: "./mpi-tool-block.schema.json",
      hidden: ["grep"],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.config.schemaRef, "./mpi-tool-block.schema.json");
    assert.equal(parseToolBlockConfig({ $schema: 42 }).ok, false);

    const toggled = toggleToolBlockRow(parsed.config, {
      kind: "tool",
      name: "find",
    });
    const dir = tmpDir();
    const written = writeToolBlockConfig(toolBlockConfigPath(dir), toggled);
    assert.equal(written.ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "mpi-tool-block.json"), "utf8"));
    assert.equal(Object.keys(raw)[0], "$schema");
    const loaded = loadToolBlockConfig(toolBlockConfigPath(dir));
    assert.equal(loaded.ok, true);
    if (!loaded.ok || !loaded.config) return;
    assert.equal(loaded.config.schemaRef, "./mpi-tool-block.schema.json");
    assert.deepEqual(loaded.config.hidden, ["find", "grep"]);
  });

  test("accepts enabled + hidden tool entries", () => {
    const parsed = parseToolBlockConfig({
      enabled: true,
      hidden: ["browser_navigate"],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.config, {
      enabled: true,
      hidden: ["browser_navigate"],
    });
  });

  test("defaults omitted enabled/hidden", () => {
    const parsed = parseToolBlockConfig({});
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.config, { enabled: true, hidden: [] });
  });

  test("accepts hidden entries with only a tool name", () => {
    const parsed = parseToolBlockConfig({ hidden: ["bash"] });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.config.hidden, ["bash"]);
  });

  test("rejects invalid JSON shapes fail-loud", () => {
    assert.equal(parseToolBlockConfig([]).ok, false);
    assert.equal(parseToolBlockConfig("x").ok, false);
    assert.equal(parseToolBlockConfig({ enabled: "yes" }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: "bash" }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: [""] }).ok, false);
    assert.equal(parseToolBlockConfig({ hidden: [7] }).ok, false);
    assert.equal(parseToolBlockConfig({ extra: true }).ok, false);
    assert.equal(
      parseToolBlockConfig({
        hidden: ["bash", "bash"],
      }).ok,
      false,
    );
  });

  test("rejects the removed { tool } entry shape fail-loud", () => {
    const parsed = parseToolBlockConfig({ hidden: [{ tool: "bash" }] });
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.error, /hidden\[0\] must be a non-empty tool name/);
  });
});

describe("deniedToolNames / planActiveTools", () => {
  const config: ToolBlockConfig = {
    enabled: true,
    hidden: ["browser_navigate", "create_goal"],
  };

  test("enabled config denies only listed names", () => {
    assert.deepEqual(deniedToolNames(config), ["browser_navigate", "create_goal"]);
  });

  test("session config replaces global while present", () => {
    const globalCfg: ToolBlockConfig = {
      enabled: true,
      hidden: ["bash"],
    };
    const sessionCfg: ToolBlockConfig = {
      enabled: true,
      hidden: ["read"],
    };
    assert.deepEqual(effectiveToolBlockConfig({ global: globalCfg }), globalCfg);
    assert.deepEqual(
      effectiveToolBlockConfig({ global: globalCfg, session: sessionCfg }),
      sessionCfg,
    );
    assert.equal(effectiveToolBlockConfig({ global: null }), null);
    assert.deepEqual(
      deniedToolNames(effectiveToolBlockConfig({ global: globalCfg, session: sessionCfg })),
      ["read"],
    );
    assert.deepEqual(
      deniedToolNames(
        effectiveToolBlockConfig({
          global: globalCfg,
          session: { enabled: false, hidden: ["read"] },
        }),
      ),
      [],
    );
  });

  test("project merges with global and replaces it only when it is the session override", () => {
    const globalCfg: ToolBlockConfig = { enabled: true, hidden: ["create_goal", "bash"] };
    const projectCfg: ToolBlockConfig = { enabled: true, hidden: ["browser_navigate", "bash"] };

    assert.deepEqual(effectiveToolBlockConfig({ global: globalCfg, project: projectCfg }), {
      enabled: true,
      hidden: ["bash", "browser_navigate", "create_goal"],
    });
    assert.deepEqual(effectiveToolBlockConfig({ global: null, project: projectCfg }), {
      enabled: true,
      hidden: ["bash", "browser_navigate"],
    });
    assert.deepEqual(effectiveToolBlockConfig({ global: globalCfg, project: null }), {
      enabled: true,
      hidden: ["bash", "create_goal"],
    });
    assert.deepEqual(
      effectiveToolBlockConfig({
        global: globalCfg,
        project: projectCfg,
        session: { enabled: true, hidden: ["read"] },
      }),
      { enabled: true, hidden: ["read"] },
    );
  });

  test("a disabled layer contributes nothing without cancelling the other", () => {
    const disabledProject: ToolBlockConfig = { enabled: false, hidden: ["browser_navigate"] };
    assert.deepEqual(
      mergeToolBlockConfigs([{ enabled: true, hidden: ["bash"] }, disabledProject]),
      { enabled: true, hidden: ["bash"] },
    );
    assert.deepEqual(mergeToolBlockConfigs([]), { enabled: true, hidden: [] });
  });

  test("project config path follows the distribution config directory", () => {
    assert.equal(
      projectToolBlockConfigPath("/repo", ".pi"),
      path.join("/repo", ".pi", "mpi-tool-block.json"),
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
    assert.equal(
      pluginTag({ source: "npm:pi-web-access", path: "/x/node_modules/pi-web-access/index.ts" }),
      "pi-web-access",
    );
    assert.equal(
      pluginTag({ source: "package", path: "/home/u/.pi/agent/extensions/mpi-goal/index.ts" }),
      "mpi-goal",
    );
  });

  test("buildToolBlockRows groups by plugin and marks hidden tools", () => {
    const rows = buildToolBlockRows(
      tools,
      {
        enabled: true,
        hidden: ["create_goal"],
      },
      ["bash", "create_goal", "browser_navigate"],
    );
    assert.equal(rows[0]?.kind, "layer");
    assert.equal(rows[1]?.kind, "enabled");
    assert.ok(rows.some((row) => row.kind === "header" && row.label === "mpi-goal"));
    const goal = rows.find((row) => row.kind === "tool" && row.name === "create_goal");
    assert.ok(goal && goal.kind === "tool");
    assert.equal(goal.hidden, true);
    assert.equal(goal.inactive, false);
    const bash = rows.find((row) => row.kind === "tool" && row.name === "bash");
    assert.ok(bash && bash.kind === "tool");
    assert.equal(bash.hidden, false);
    assert.equal(bash.inactive, false);
  });

  test("marks registered tools inactive when they are not in the active set", () => {
    const rows = buildToolBlockRows(
      [...tools, { name: "grep", plugin: "" }],
      { enabled: true, hidden: ["create_goal"] },
      ["bash"],
    );
    const grep = rows.find((row) => row.kind === "tool" && row.name === "grep");
    assert.ok(grep && grep.kind === "tool");
    assert.equal(grep.hidden, false);
    assert.equal(grep.inactive, true);
    const hiddenGoal = rows.find((row) => row.kind === "tool" && row.name === "create_goal");
    assert.ok(hiddenGoal && hiddenGoal.kind === "tool");
    assert.equal(hiddenGoal.hidden, true);
    assert.equal(hiddenGoal.inactive, false);
    const bash = rows.find((row) => row.kind === "tool" && row.name === "bash");
    assert.ok(bash && bash.kind === "tool");
    assert.equal(bash.hidden, false);
    assert.equal(bash.inactive, false);
  });

  test("keeps orphan hidden tools in the list under a not-registered header", () => {
    const rows = buildToolBlockRows(
      tools,
      {
        enabled: true,
        hidden: ["gone_tool"],
      },
      ["bash", "create_goal", "browser_navigate"],
    );
    const orphan = rows.find((row) => row.kind === "tool" && row.name === "gone_tool");
    assert.ok(orphan && orphan.kind === "tool");
    assert.equal(orphan.hidden, true);
    assert.ok(rows.some((row) => row.kind === "header" && row.label === "not registered"));
  });

  test("filterToolBlockRows keeps plugin headers for matches", () => {
    const rows = buildToolBlockRows(tools, { enabled: true, hidden: [] }, [
      "bash",
      "create_goal",
      "browser_navigate",
    ]);
    const filtered = filterToolBlockRows(rows, "goal");
    assert.equal(filtered[0]?.kind, "layer");
    assert.ok(filtered.some((row) => row.kind === "header" && row.label === "mpi-goal"));
    assert.ok(filtered.some((row) => row.kind === "tool" && row.name === "create_goal"));
    assert.equal(
      filtered.some((row) => row.kind === "tool" && row.name === "bash"),
      false,
    );
  });

  test("filterToolBlockRows matches hidden/visible/inactive state words", () => {
    const rows = buildToolBlockRows(
      [...tools, { name: "grep", plugin: "" }],
      { enabled: true, hidden: ["create_goal"] },
      ["bash"],
    );
    const inactive = filterToolBlockRows(rows, "inactive");
    assert.equal(inactive[0]?.kind, "layer");
    assert.ok(inactive.some((row) => row.kind === "tool" && row.name === "grep"));
    assert.equal(
      inactive.some((row) => row.kind === "tool" && row.name === "bash"),
      false,
    );
    const hidden = filterToolBlockRows(rows, "hidden");
    assert.ok(hidden.some((row) => row.kind === "tool" && row.name === "create_goal"));
    assert.equal(
      hidden.some((row) => row.kind === "tool" && row.name === "grep"),
      false,
    );
  });

  test("toggle hides, unhides, and flips enabled without dropping other rows", () => {
    let next = toggleToolBlockRow(
      { enabled: true, hidden: [] },
      {
        kind: "tool",
        name: "create_goal",
      },
    );
    assert.deepEqual(next.hidden, ["create_goal"]);
    next = toggleToolBlockRow(next, { kind: "enabled" });
    assert.equal(isToolBlockEnabled(next), false);
    assert.equal(next.hidden.length, 1);
    next = toggleToolBlockRow(next, {
      kind: "tool",
      name: "create_goal",
    });
    assert.deepEqual(next.hidden, []);
    assert.equal(next.enabled, false);
  });
});

describe("load / write mpi-tool-block.json", () => {
  test("missing file is a no-op config", () => {
    const dir = tmpDir();
    const loaded = loadToolBlockConfig(toolBlockConfigPath(dir));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.missing, true);
    assert.equal(loaded.config, null);
    assert.equal(loaded.path, toolBlockConfigPath(dir));
  });

  test("round-trips a written config and fail-louds invalid files", () => {
    const dir = tmpDir();
    const written = writeToolBlockConfig(toolBlockConfigPath(dir), {
      enabled: true,
      hidden: ["bash"],
    });
    assert.equal(written.ok, true);
    if (!written.ok) return;
    const loaded = loadToolBlockConfig(toolBlockConfigPath(dir));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.config, {
      enabled: true,
      hidden: ["bash"],
    });

    fs.writeFileSync(toolBlockConfigPath(dir), "{", "utf8");
    const bad = loadToolBlockConfig(toolBlockConfigPath(dir));
    assert.equal(bad.ok, false);
  });

  test("writes a project file at the given path without touching a global directory", () => {
    const cwd = tmpDir();
    const filePath = projectToolBlockConfigPath(cwd, ".pi");
    const written = writeToolBlockConfig(filePath, { enabled: true, hidden: ["bash"] });
    assert.equal(written.ok, true);
    assert.equal(written.path, filePath);
    const loaded = loadToolBlockConfig(filePath);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.config?.hidden, ["bash"]);
  });
});

describe("tool-block overlay", () => {
  const tools: ToolRef[] = [
    { name: "bash", plugin: "" },
    { name: "create_goal", plugin: "mpi-goal" },
  ];
  const allActive = () => tools.map((tool) => tool.name);

  test("renders settings-style rows, title, and config path", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    let draft: ToolBlockConfig = {
      enabled: true,
      hidden: ["create_goal"],
    };
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: draft,
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config) => {
        draft = config;
        return { ok: true, config };
      },
      getActiveNames: allActive,
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
    assert.match(text, /\/tmp\/agent\/mpi-tool-block.json/);
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
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config, layer) => {
        writes.push({ config, layer });
        return { ok: true, config };
      },
      getActiveNames: allActive,
    });
    view.handleInput("\x1b[B"); // skip layer -> enabled
    view.handleInput("\x1b[B"); // skip enabled -> bash
    view.handleInput(" ");
    assert.equal(writes.at(-1)?.layer, "global");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["bash"]);
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
      hidden: ["create_goal"],
    };
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: global,
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config, layer) => {
        writes.push({ config, layer });
        return { ok: true, config };
      },
      getActiveNames: allActive,
    });
    view.handleInput(" "); // Layer -> Session, snapshot global
    assert.equal(writes.at(-1)?.layer, "session");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["create_goal"]);
    assert.match(view.render(60).join("\n"), /session \(in-memory\)/);
    assert.match(view.render(60).join("\n"), /Layer[\s\S]*Session/);

    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash
    view.handleInput(" ");
    assert.equal(writes.at(-1)?.layer, "session");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["bash", "create_goal"]);

    view.handleInput("\x1b[A");
    view.handleInput("\x1b[A");
    view.handleInput(" "); // Layer -> Global, session stays
    assert.match(
      view.render(60).join("\n"),
      /session override · \/tmp\/agent\/mpi-tool-block.json/,
    );
    const beforeGlobalEdit = writes.length;
    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash on global draft (still empty hidden)
    view.handleInput(" ");
    assert.equal(writes.length, beforeGlobalEdit + 1);
    assert.equal(writes.at(-1)?.layer, "global");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["bash", "create_goal"]);
  });

  test("renders inactive for registered tools that are not in the active set", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const listed: ToolRef[] = [...tools, { name: "grep", plugin: "" }];
    let hidden: ToolBlockConfig["hidden"] = [];
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools: listed,
      initial: { enabled: true, hidden },
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config) => {
        hidden = config.hidden;
        return { ok: true, config };
      },
      getActiveNames: () => ["bash", "create_goal"],
    });
    const text = view.render(60).join("\n");
    assert.match(text, /bash\s+Visible/);
    assert.match(text, /grep\s+Inactive/);
    assert.match(text, /create_goal\s+Visible/);

    view.handleInput("i");
    view.handleInput("n");
    const filtered = view.render(60).join("\n");
    assert.match(filtered, /grep[\s\S]*Inactive/);
    assert.doesNotMatch(filtered, /\bbash\b/);
    assert.match(filtered, /Layer/);

    view.handleInput("\x1b"); // clear filter
    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash
    view.handleInput("\x1b[B"); // grep
    view.handleInput(" ");
    assert.deepEqual(hidden, ["grep"]);
    assert.match(view.render(60).join("\n"), /grep[\s\S]*Hidden/);
  });

  test("windows the list when the overlay body budget is short", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${String(i).padStart(2, "0")}`,
      plugin: "",
    }));
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools: many,
      initial: { enabled: true, hidden: [] },
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config) => ({ ok: true, config }),
      getActiveNames: () => many.map((tool) => tool.name),
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

describe("project layer", () => {
  const theme = {
    fg: (_c: string, text: string) => text,
    bg: (_c: string, text: string) => text,
    bold: (text: string) => text,
  };
  const tools: ToolRef[] = [
    { name: "bash", plugin: "" },
    { name: "create_goal", plugin: "mpi-goal" },
  ];

  test("layer row cycles through Project and persists project edits there", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const writes: Array<{ config: ToolBlockConfig; layer: string }> = [];
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: { enabled: true, hidden: ["create_goal"] },
      project: { enabled: true, hidden: [] },
      projectPath: "/tmp/repo/.pi/mpi-tool-block.json",
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config, layer) => {
        writes.push({ config, layer });
        return { ok: true, config };
      },
      getActiveNames: () => tools.map((tool) => tool.name),
    });

    view.handleInput(" "); // Global -> Project
    const projectView = view.render(60).join("\n");
    assert.match(projectView, /Layer[\s\S]*Project/);
    assert.match(projectView, /\/tmp\/repo\/\.pi\/mpi-tool-block\.json/);

    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash
    view.handleInput(" ");
    assert.equal(writes.at(-1)?.layer, "project");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["bash"]);

    view.handleInput("\x1b[A"); // enabled
    view.handleInput("\x1b[A"); // layer
    view.handleInput(" "); // Project -> Session, snapshot of global + project
    assert.equal(writes.at(-1)?.layer, "session");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["bash", "create_goal"]);
  });

  test("a failed session-snapshot persist keeps the previous layer and draft", async () => {
    const { createToolBlockOverlay } = await import("./tool-block-overlay.js");
    const errors: string[] = [];
    const writes: Array<{ config: ToolBlockConfig; layer: string }> = [];
    const view = createToolBlockOverlay({
      theme,
      requestRender: () => undefined,
      done: () => undefined,
      tools,
      initial: { enabled: true, hidden: ["create_goal"] },
      project: { enabled: true, hidden: [] },
      projectPath: "/tmp/repo/.pi/mpi-tool-block.json",
      configPath: "/tmp/agent/mpi-tool-block.json",
      persist: (config, layer) => {
        if (layer === "session") return { ok: false, error: "Error: failed to snapshot" };
        writes.push({ config, layer });
        return { ok: true, config };
      },
      onError: (message) => errors.push(message),
      getActiveNames: () => tools.map((tool) => tool.name),
    });

    view.handleInput(" "); // Global -> Project
    view.handleInput(" "); // Project -> Session; snapshot persist fails
    assert.deepEqual(errors, ["Error: failed to snapshot"]);
    const afterFailure = view.render(60).join("\n");
    assert.match(afterFailure, /Layer[\s\S]*Project/);
    assert.doesNotMatch(afterFailure, /session \(in-memory\)/);

    view.handleInput("\x1b[B"); // enabled
    view.handleInput("\x1b[B"); // bash
    view.handleInput(" "); // toggle still targets the project layer
    assert.equal(writes.at(-1)?.layer, "project");
    assert.deepEqual(writes.at(-1)?.config.hidden, ["bash"]);
  });

  test("/tool-block names a broken project file and refuses to open", async () => {
    const { default: toolBlockExtension } = await import("./index.js");
    const root = tmpDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const brokenProjectPath = projectToolBlockConfigPath(cwd, ".pi");
    fs.writeFileSync(brokenProjectPath, "{", "utf8");

    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
      const notifications: string[] = [];
      let customCalls = 0;
      toolBlockExtension({
        on() {},
        registerCommand(
          _name: string,
          def: { handler: (args: string, ctx: unknown) => Promise<void> },
        ) {
          handler = def.handler;
        },
        getAllTools: () => [{ name: "bash" }],
        getActiveTools: () => ["bash"],
        setActiveTools() {},
      } as never);

      assert.ok(handler, "tool-block command must be registered");
      await handler("", {
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          custom: async () => {
            customCalls += 1;
          },
          notify: (message: string) => notifications.push(message),
        },
      } as never);

      assert.equal(customCalls, 0);
      assert.equal(notifications.length, 1);
      assert.ok(notifications[0]?.includes(brokenProjectPath));
      assert.match(notifications[0] ?? "", /^Error: tool-block config error/);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("an untrusted project is left out of the effective set", async () => {
    const { default: toolBlockExtension } = await import("./index.js");
    const root = tmpDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      toolBlockConfigPath(agentDir),
      JSON.stringify({ enabled: true, hidden: ["bash"] }),
      "utf8",
    );
    fs.writeFileSync(
      projectToolBlockConfigPath(cwd, ".pi"),
      JSON.stringify({ enabled: true, hidden: ["read"] }),
      "utf8",
    );

    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const applied: string[][] = [];
      let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
      toolBlockExtension({
        on(event: string, handler: (event: unknown, ctx: unknown) => void) {
          if (event === "session_start") sessionStart = handler;
        },
        registerCommand() {},
        getAllTools: () => [{ name: "bash" }, { name: "read" }, { name: "write" }],
        getActiveTools: () => ["bash", "read", "write"],
        setActiveTools: (names: string[]) => {
          applied.push(names);
        },
      } as never);

      assert.ok(sessionStart, "session_start handler must be registered");
      sessionStart({}, { cwd, isProjectTrusted: () => false });
      assert.deepEqual(applied, [["read", "write"]]);

      sessionStart({}, { cwd, isProjectTrusted: () => true });
      assert.deepEqual(applied, [["read", "write"], ["write"]]);

      // A broken project file drops that layer only; the global layer keeps applying.
      fs.writeFileSync(projectToolBlockConfigPath(cwd, ".pi"), "{", "utf8");
      sessionStart({}, { cwd, isProjectTrusted: () => true });
      assert.deepEqual(applied, [["read", "write"], ["write"], ["read", "write"]]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("bundled skill", () => {
  test("resources_discover exposes a loadable manual-only skill", async () => {
    const { default: toolBlockExtension } = await import("./index.js");
    const handlers = new Map<string, () => unknown>();
    toolBlockExtension({
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    } as never);

    const discover = handlers.get("resources_discover") as
      | (() => { skillPaths: string[] })
      | undefined;
    assert.ok(discover, "resources_discover handler must be registered");
    const skillPaths = discover().skillPaths;
    assert.deepEqual(skillPaths, [path.join(import.meta.dirname, "skills")]);

    const { skills, diagnostics } = loadSkills({
      cwd: import.meta.dirname,
      agentDir: import.meta.dirname,
      skillPaths,
      includeDefaults: false,
    });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      skills.map((skill) => [skill.name, skill.disableModelInvocation]),
      [["mpi-tool-block", true]],
    );
  });
});
