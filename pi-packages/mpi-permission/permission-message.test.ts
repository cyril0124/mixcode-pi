import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import permissionSchema from "./mpi-permission.schema.json" with { type: "json" };
import {
  evaluateToolCall,
  loadPermissionConfig,
  parsePermissionConfig,
  serializePermissionConfig,
  writePermissionConfig,
  type LayeredConfig,
  type PermissionConfig,
} from "./permission-core.js";
import { createPermissionOverlay } from "./permission-overlay.js";

function parse(raw: unknown): PermissionConfig {
  const result = parsePermissionConfig(raw);
  if (!result.ok) assert.fail(result.error);
  return result.config;
}

const cwd = "/project";
const home = "/home/test";

function evaluate(layers: LayeredConfig[], command: string, doomCount = 0) {
  return evaluateToolCall({ layers, toolName: "bash", input: { command }, cwd, home, doomCount });
}

test("action objects reject malformed fields with the offending config location", () => {
  for (const value of [
    { action: "deny", message: 42 },
    { action: "deny", message: null },
    { action: "deny", mesage: "typo" },
    { message: "missing action" },
    { action: "invalid" },
    [],
    null,
  ]) {
    for (const config of [{ bash: { "git *": value } }, { doom_loop: value }]) {
      assert.equal(Value.Check(permissionSchema, config), false, JSON.stringify(config));
      const result = parsePermissionConfig(config);
      assert.equal(result.ok, false, JSON.stringify(config));
      if (!result.ok) assert.match(result.error, "bash" in config ? /bash.*git \*/ : /doom_loop/);
    }
  }
});

test("message round-trip keeps wildcard objects, empty messages, and literal message patterns", () => {
  const raw = {
    bash: { "*": { action: "deny", message: "Use the approved command.\nAsk the user." } },
    read: { "*.env": { action: "deny", message: "" }, "*.example": "allow" },
    custom: { action: "deny", message: "ask" },
    doom_loop: { action: "deny", message: "Change the input before retrying." },
  };
  assert.equal(Value.Check(permissionSchema, raw), true);
  assert.deepEqual(serializePermissionConfig(parse(raw)), raw);
});

test("only the winning deny supplies a message across layers and compound segments", () => {
  const layers: LayeredConfig[] = [
    { layer: "global", config: parse({ bash: { "*": { action: "deny", message: "global" } } }) },
    {
      layer: "project",
      config: parse({
        bash: {
          "git *": { action: "deny", message: "project" },
          "git status": "allow",
          "git diff": { action: "ask", message: "inactive" },
          "git log": "deny",
        },
      }),
    },
  ];
  assert.equal(evaluate(layers, "git push").message, "project");
  assert.equal(evaluate(layers, "git status").action, "allow");
  assert.equal(evaluate(layers, "git status").message, undefined);
  assert.equal(evaluate(layers, "git diff").action, "ask");
  assert.equal(evaluate(layers, "git diff").message, undefined);
  assert.equal(evaluate(layers, "git log").message, undefined);
  assert.equal(evaluate(layers, "git push && rm file").message, "project");
  assert.equal(evaluate(layers, "rm file && git push").message, "global");
});

test("external-directory and doom-loop denials carry their own messages", () => {
  const layers: LayeredConfig[] = [
    {
      layer: "global",
      config: parse({
        external_directory: { "*": { action: "deny", message: "Stay in the project." } },
        doom_loop: { action: "deny", message: "Do not repeat this input." },
      }),
    },
  ];
  const external = evaluateToolCall({
    layers,
    toolName: "read",
    input: { path: "/outside/secret" },
    cwd,
    home,
  });
  assert.equal(external.action, "deny");
  assert.equal(external.message, "Stay in the project.");
  assert.equal(evaluate(layers, "echo repeat", 2).message, undefined);
  assert.equal(evaluate(layers, "echo repeat", 3).message, "Do not repeat this input.");
  layers.push({ layer: "project", config: parse({ doom_loop: "deny" }) });
  assert.equal(evaluate(layers, "echo repeat", 3).message, undefined);
});

test("overlay action edits persist messages and deleting doom_loop removes its message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permission-message-"));
  try {
    const file = path.join(dir, "mpi-permission.json");
    const config = parse({
      bash: { "*": { action: "deny", message: "Run manually." } },
      doom_loop: { action: "ask", message: "Change the input." },
    });
    const overlay = createPermissionOverlay({
      theme: { fg: (_color, text) => text, bold: (text) => text },
      requestRender() {},
      done() {},
      trusted: true,
      paths: { global: file, project: file },
      initial: { global: config, project: { entries: [] }, session: { entries: [] } },
      knownKeys: ["bash"],
      persist: (next) => writePermissionConfig(file, next),
    });
    const readConfig = () => {
      const loaded = loadPermissionConfig(file);
      if (!loaded.ok || !loaded.config) assert.fail("saved config must load");
      return loaded.config;
    };
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    assert.equal(
      evaluate([{ layer: "global", config: readConfig() }], "echo x", 3).message,
      "Run manually.",
    );
    overlay.handleInput("\x1b[B");
    for (const action of ["allow", "ask", "deny"]) {
      overlay.handleInput("\r");
      const saved = serializePermissionConfig(readConfig());
      assert.deepEqual(saved.bash, { "*": { action, message: "Run manually." } });
      assert.deepEqual(saved.doom_loop, { action: "deny", message: "Change the input." });
    }
    overlay.handleInput("\x1b[A");
    overlay.handleInput("d");
    assert.equal(serializePermissionConfig(readConfig()).doom_loop, undefined);
    assert.deepEqual(serializePermissionConfig(readConfig()).bash, {
      "*": { action: "deny", message: "Run manually." },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
