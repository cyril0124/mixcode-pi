import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { createToolDisplayConfigOverlay } from "./config-overlay.js";
import {
  DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG,
  type ToolDisplayRuntimeConfig,
  loadToolDisplayRuntimeConfig,
  parseToolDisplayRuntimeConfig,
  toolDisplayConfigPath,
  writeToolDisplayRuntimeConfig,
} from "./config.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tool-display-config-"));
  tempDirs.push(dir);
  return dir;
}

function plainTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

test("missing global config defaults raw tool arguments to off", () => {
  const dir = tempDir();
  const loaded = loadToolDisplayRuntimeConfig(dir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.missing, true);
  assert.deepEqual(loaded.config, DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG);
  assert.equal(loaded.path, toolDisplayConfigPath(dir));
});

test("global config round-trips every strict boolean with private permissions", () => {
  const dir = tempDir();
  const written = writeToolDisplayRuntimeConfig(dir, {
    showRawToolArguments: true,
    compactBashCallRow: false,
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(written.path, "utf8"),
    '{\n  "showRawToolArguments": true,\n  "compactBashCallRow": false\n}\n',
  );

  const loaded = loadToolDisplayRuntimeConfig(dir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.missing, false);
  assert.deepEqual(loaded.config, { showRawToolArguments: true, compactBashCallRow: false });
});

test("global config rejects malformed JSON, unknown keys, and wrong values", () => {
  assert.throws(() => parseToolDisplayRuntimeConfig({ extra: true }), /unknown key "extra"/);
  assert.throws(
    () => parseToolDisplayRuntimeConfig({ showRawToolArguments: "yes" }),
    /must be a boolean/,
  );
  assert.throws(
    () => parseToolDisplayRuntimeConfig({ compactBashCallRow: "on" }),
    /compactBashCallRow must be a boolean/,
  );
  // An absent key keeps its default instead of failing.
  assert.deepEqual(parseToolDisplayRuntimeConfig({}), DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG);
  assert.deepEqual(parseToolDisplayRuntimeConfig({ compactBashCallRow: false }), {
    showRawToolArguments: false,
    compactBashCallRow: false,
  });

  const dir = tempDir();
  fs.writeFileSync(toolDisplayConfigPath(dir), "{", "utf8");
  const loaded = loadToolDisplayRuntimeConfig(dir);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /JSON|position|Expected property name/i);
});

test("a config file carrying the ignored excerpt key still loads", () => {
  const dir = tempDir();
  // The key is ignored whatever value it carries, so no value can fail the load.
  for (const value of ["true", "false", '"on"', "1", "null"]) {
    fs.writeFileSync(
      toolDisplayConfigPath(dir),
      `{"showRawToolArguments": false, "compactBashCallRow": true, "compactBashCommandHint": ${value}}\n`,
      "utf8",
    );
    const loaded = loadToolDisplayRuntimeConfig(dir);
    assert.equal(loaded.ok, true, `value ${value} must load`);
    if (!loaded.ok) continue;
    assert.deepEqual(loaded.config, { showRawToolArguments: false, compactBashCallRow: true });
  }

  // A file carrying nothing but the ignored key loads with every live default.
  fs.writeFileSync(toolDisplayConfigPath(dir), '{"compactBashCommandHint": false}\n', "utf8");
  const onlyIgnored = loadToolDisplayRuntimeConfig(dir);
  assert.equal(onlyIgnored.ok, true);
  if (!onlyIgnored.ok) return;
  assert.deepEqual(onlyIgnored.config, DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG);
});

test("config overlay lists every setting and toggles the selected one", () => {
  const changes: Array<Partial<ToolDisplayRuntimeConfig>> = [];
  let closed = false;
  const view = createToolDisplayConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => {
      closed = true;
    },
    configPath: "/tmp/agent/mpi-tool-display.json",
    initial: {
      showRawToolArguments: false,
      compactBashCallRow: true,
    },
    persist: (config) => {
      changes.push({ ...config });
      return { ok: true, config };
    },
    onError: () => assert.fail("unexpected persistence error"),
  });

  const initial = stripAnsi(view.render(80).join("\n"));
  assert.match(initial, /^┌.*Tool Display.*┐$/m);
  assert.match(initial, /› Compact bash call row {4}on/);
  assert.match(initial, /Raw tool arguments\s+off/);
  assert.doesNotMatch(
    initial,
    /Command excerpt\s+o(n|ff)/,
    "the ignored key has no row of its own",
  );
  assert.match(initial, /One row per finished bash call/);
  assert.match(initial, /\/tmp\/agent\/mpi-tool-display\.json/);
  assert.match(initial, /Esc close/);

  // Enter toggles the selected row only.
  view.handleInput("\r");
  assert.deepEqual(changes, [{ showRawToolArguments: false, compactBashCallRow: false }]);
  assert.match(stripAnsi(view.render(80).join("\n")), /› Compact bash call row {4}off/);

  // j/down reaches the debug row and reveals its warning.
  view.handleInput("j");
  const second = stripAnsi(view.render(80).join("\n"));
  assert.match(second, /› Raw tool arguments\s+off/);
  assert.match(second, /may expose secrets/);

  view.handleInput("\r");
  assert.equal(changes.length, 2);
  assert.equal(changes[1]!.showRawToolArguments, true);
  assert.equal(changes[1]!.compactBashCallRow, false, "the first toggle survives the second");
  assert.match(stripAnsi(view.render(80).join("\n")), /› Raw tool arguments\s+on/);

  // Wrapping selection keeps every row reachable.
  view.handleInput("j");
  assert.match(stripAnsi(view.render(80).join("\n")), /› Compact bash call row {4}off/);
  view.handleInput("k");
  assert.match(stripAnsi(view.render(80).join("\n")), /› Raw tool arguments\s+on/);

  view.handleInput("\x1b");
  assert.equal(closed, true);
});

test("config overlay restores the visible value when persistence fails", () => {
  const errors: string[] = [];
  const view = createToolDisplayConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => undefined,
    configPath: "/tmp/agent/mpi-tool-display.json",
    initial: {
      showRawToolArguments: false,
      compactBashCallRow: true,
    },
    persist: () => ({ ok: false, error: "disk full" }),
    onError: (message) => errors.push(message),
  });

  view.handleInput(" ");
  assert.deepEqual(errors, ["disk full"]);
  assert.match(stripAnsi(view.render(80).join("\n")), /\boff\b/);
});
